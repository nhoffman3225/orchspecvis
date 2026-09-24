"""Constant-Q transform on the bundle's MIDI frequency axis.

Axis invariant: bin b <-> MIDI 21 + b/k, fmin = A0 (27.5 Hz), bins_per_octave = 12k,
n_bins = 88k (A0 .. C8 + (k-1)/k).

Frame convention: centered, frame t at sample t*hop, n_frames = 1 + n_samples // hop.

Backends return librosa-compatible magnitude (``librosa.cqt(..., scale=True)``);
``calibrated_db`` converts it to "dB re a full-scale sine centered on the bin", which is
what the bundle stores.

Backends:
- ``librosa``: reference, CPU.
- ``torch``: the same multirate algorithm (per-octave FFT kernels applied to an STFT, x2
  decimation between octaves) on CUDA/MPS/CPU. Kernels are built with librosa's public
  filter functions, so only the decimation filter differs from the reference.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import cached_property
from typing import Protocol

import librosa
import numpy as np

A0_MIDI = 21
N_KEYS = 88


@dataclass(frozen=True)
class CQTSpec:
    sr: int
    hop: int = 512
    k: int = 3
    filter_scale: float = 1.0
    window: str = "hann"
    n_bins: int = field(default=0)  # 0 -> 88 * k

    def __post_init__(self) -> None:
        if self.k not in (1, 2, 3, 4):
            raise ValueError(f"k must be 1..4 (bins per semitone), got {self.k}")
        if self.n_bins == 0:
            object.__setattr__(self, "n_bins", N_KEYS * self.k)
        need = 2 ** (self.n_octaves - 1)
        if self.hop % need:
            raise ValueError(
                f"hop={self.hop} must be a multiple of {need} for {self.n_octaves} "
                "octaves (multirate CQT)"
            )
        top = self.freqs[-1]
        if top * 1.1 >= self.sr / 2:
            raise ValueError(f"sr={self.sr} too low for top bin at {top:.0f} Hz")

    @property
    def bins_per_octave(self) -> int:
        return 12 * self.k

    @property
    def fmin_hz(self) -> float:
        return 440.0 * 2.0 ** ((A0_MIDI - 69) / 12)

    @property
    def n_octaves(self) -> int:
        return math.ceil(self.n_bins / self.bins_per_octave)

    @property
    def freqs(self) -> np.ndarray:
        return self.fmin_hz * 2.0 ** (np.arange(self.n_bins) / self.bins_per_octave)

    @property
    def midi(self) -> np.ndarray:
        """MIDI pitch of each bin, shape (n_bins,)."""
        return A0_MIDI + np.arange(self.n_bins) / self.k

    def n_frames(self, n_samples: int) -> int:
        return 1 + n_samples // self.hop

    @cached_property
    def sine_gain(self) -> np.ndarray:
        """Magnitude a unit-amplitude sine at each bin's center produces, shape (n_bins,).

        With librosa's L1-normalised (norm=1) filters and scale=True the response to
        A*cos(w t) at the filter's center frequency is A * sqrt(L_b) / 2, where L_b is the
        filter length in samples at the input sample rate.
        """
        lengths, _ = librosa.filters.wavelet_lengths(
            freqs=self.freqs, sr=self.sr, window=self.window, filter_scale=self.filter_scale
        )
        return (np.sqrt(lengths) / 2.0).astype(np.float64)


def calibrated_db(mag: np.ndarray, spec: CQTSpec, floor_db: float = -200.0) -> np.ndarray:
    """(n_bins, n_frames) magnitude -> float32 dB re full-scale sine per bin."""
    g = spec.sine_gain.astype(np.float32)[:, None]
    tiny = np.float32(10.0 ** (floor_db / 20.0))
    return (20.0 * np.log10(np.maximum(mag / g, tiny))).astype(np.float32)


def _fix_frames(c: np.ndarray, n_frames: int) -> np.ndarray:
    if c.shape[-1] > n_frames:
        return c[..., :n_frames]
    if c.shape[-1] < n_frames:  # pragma: no cover - librosa already yields 1 + n//hop
        pad = [(0, 0)] * (c.ndim - 1) + [(0, n_frames - c.shape[-1])]
        return np.pad(c, pad, mode="edge")
    return c


def relative_bandwidth(freqs: np.ndarray) -> np.ndarray:
    """Per-bin relative bandwidth, same formula as librosa.filters._relative_bandwidth."""
    logf = np.log2(freqs)
    bpo = np.empty_like(freqs)
    bpo[0] = 1 / (logf[1] - logf[0])
    bpo[-1] = 1 / (logf[-1] - logf[-2])
    bpo[1:-1] = 2 / (logf[2:] - logf[:-2])
    return (2.0 ** (2 / bpo) - 1) / (2.0 ** (2 / bpo) + 1)


class CQTBackend(Protocol):
    name: str

    def magnitude(self, y: np.ndarray, spec: CQTSpec) -> np.ndarray:
        """Mono float32 (n,) -> float32 magnitude (n_bins, 1 + n // hop)."""
        ...


class LibrosaBackend:
    name = "librosa"

    def magnitude(self, y: np.ndarray, spec: CQTSpec) -> np.ndarray:
        c = librosa.cqt(
            np.ascontiguousarray(y, dtype=np.float32),
            sr=spec.sr,
            hop_length=spec.hop,
            fmin=spec.fmin_hz,
            n_bins=spec.n_bins,
            bins_per_octave=spec.bins_per_octave,
            tuning=0.0,
            filter_scale=spec.filter_scale,
            window=spec.window,
            scale=True,
        )
        return _fix_frames(np.abs(c).astype(np.float32), spec.n_frames(len(y)))


class TorchBackend:
    """Multirate kernel CQT in torch, mirroring librosa.vqt's algorithm."""

    name = "torch"

    def __init__(self, device: str | None = None, batch: int = 1) -> None:
        import torch

        self.torch = torch
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = torch.device(device)
        self.batch = batch
        self._plans: dict[CQTSpec, _TorchPlan] = {}

    def _plan(self, spec: CQTSpec) -> _TorchPlan:
        if spec not in self._plans:
            self._plans[spec] = _TorchPlan(spec, self.torch, self.device)
        return self._plans[spec]

    def magnitude(self, y: np.ndarray, spec: CQTSpec) -> np.ndarray:
        return self.magnitude_batch(y[None, :], spec)[0]

    def magnitude_batch(self, ys: np.ndarray, spec: CQTSpec) -> np.ndarray:
        """(B, n) -> (B, n_bins, n_frames) float32 on the host."""
        t = self.torch.from_numpy(np.ascontiguousarray(ys, dtype=np.float32)).to(self.device)
        with self.torch.inference_mode():
            out = self._plan(spec).run(t)
        return out.cpu().numpy()

    def calibrated_db_u8(
        self, y: np.ndarray, spec: CQTSpec, db_min: float, db_max: float
    ) -> tuple[np.ndarray, np.ndarray]:
        """Mono (n,) -> (calibrated dB float32 (n_bins, n_frames), u8 frame-major).

        Does the dB + quantization on the device, which avoids a second pass on the CPU.
        """
        torch = self.torch
        plan = self._plan(spec)
        with torch.inference_mode():
            t = torch.from_numpy(np.ascontiguousarray(y[None, :], dtype=np.float32))
            mag = plan.run(t.to(self.device))[0]
            db = 20.0 * torch.log10(torch.clamp(mag / plan.gain[:, None], min=1e-10))
            q = torch.round(
                (torch.clamp(db, db_min, db_max) - db_min) * (255.0 / (db_max - db_min))
            )
            u8 = q.to(torch.uint8).T.contiguous()
            return db.cpu().numpy(), u8.cpu().numpy()


class _TorchPlan:
    def __init__(self, spec: CQTSpec, torch, device) -> None:  # type: ignore[no-untyped-def]
        self.spec = spec
        self.torch = torch
        self.device = device
        freqs = spec.freqs
        sr = float(spec.sr)
        hop = spec.hop
        alpha = relative_bandwidth(freqs)
        _, cutoff = librosa.filters.wavelet_lengths(
            freqs=freqs, sr=sr, window=spec.window, filter_scale=spec.filter_scale, alpha=alpha
        )
        # --- early downsampling, same rule as librosa.constantq.__early_downsample_count
        n_oct = spec.n_octaves
        count1 = max(0, math.ceil(math.log2((sr / 2) / cutoff)) - 1 - 1)
        twos = (hop & -hop).bit_length() - 1
        count2 = max(0, twos - n_oct + 1)
        self.early = min(count1, count2)
        sr_e = sr / 2**self.early
        hop_e = hop // 2**self.early

        # Half-band decimator: Kaiser windowed sinc, cutoff at the new Nyquist, ~120 dB
        # stopband past 0.3 fs (librosa only halves when the next octave's top <= fs/5).
        n_taps = 161
        m = np.arange(n_taps) - (n_taps - 1) / 2
        taps = 0.5 * np.sinc(0.5 * m) * np.kaiser(n_taps, 12.0)
        taps /= taps.sum()
        self.fir = torch.tensor(taps, dtype=torch.float32, device=device).view(1, 1, -1)

        self.octaves: list[tuple[int, int, object, int]] = []  # (hop, n_fft, basis, n_rows)
        n_filters = min(spec.bins_per_octave, spec.n_bins)
        my_sr, my_hop = sr_e, hop_e
        self.downsample_after: list[bool] = []
        for i in range(n_oct):
            sl = slice(-n_filters, None) if i == 0 else slice(-n_filters * (i + 1), -n_filters * i)
            idx = np.arange(spec.n_bins)[sl]
            f_oct = freqs[idx]
            basis, lengths = librosa.filters.wavelet(
                freqs=f_oct,
                sr=my_sr,
                filter_scale=spec.filter_scale,
                norm=1,
                pad_fft=True,
                window=spec.window,
                alpha=alpha[idx],  # pyright: ignore[reportArgumentType]  (librosa passes arrays itself)
            )
            n_fft = basis.shape[1]
            basis = basis * (lengths[:, None] / float(n_fft))
            fb = np.fft.fft(basis, n=n_fft, axis=1)[:, : n_fft // 2 + 1]
            fb = librosa.util.sparsify_rows(fb, quantile=0.01).toarray()
            fb = fb * np.sqrt(sr_e / my_sr)
            fb_t = torch.tensor(fb, dtype=torch.complex64, device=device)
            self.octaves.append((my_hop, n_fft, fb_t, len(idx)))
            down = False
            if i < n_oct - 1:
                f_max_next = freqs[idx[0] - 1]
                if my_hop % 2 == 0 and f_max_next <= my_sr / 5:
                    my_hop //= 2
                    my_sr /= 2.0
                    down = True
            self.downsample_after.append(down)

        lengths_e, _ = librosa.filters.wavelet_lengths(
            freqs=freqs, sr=sr_e, window=spec.window, filter_scale=spec.filter_scale, alpha=alpha
        )
        self.inv_sqrt_len = torch.tensor(
            1.0 / np.sqrt(lengths_e), dtype=torch.float32, device=device
        )
        self.gain = torch.tensor(spec.sine_gain, dtype=torch.float32, device=device)

    def _halve(self, y):  # type: ignore[no-untyped-def]
        """(B, n) -> (B, ceil(n/2)) zero-phase lowpass + decimate, energy-scaled like
        librosa.resample(..., scale=True)."""
        torch = self.torch
        pad = self.fir.shape[-1] // 2
        z = torch.nn.functional.conv1d(y[:, None, :], self.fir, padding=pad)[:, 0, :]
        return z[:, ::2] * math.sqrt(2.0)

    def run(self, y):  # type: ignore[no-untyped-def]
        torch = self.torch
        n = y.shape[-1]
        n_frames = self.spec.n_frames(n)
        for _ in range(self.early):
            y = self._halve(y)
        outs = []
        for (hop, n_fft, fb, _rows), down in zip(self.octaves, self.downsample_after, strict=True):
            win = torch.ones(n_fft, device=y.device)
            d = torch.stft(
                y,
                n_fft=n_fft,
                hop_length=hop,
                window=win,
                center=True,
                pad_mode="constant",
                return_complex=True,
            )  # (B, F, T)
            outs.append(torch.abs(torch.matmul(fb, d)))  # (B, rows, T)
            if down:
                y = self._halve(y)
        t_min = min(o.shape[-1] for o in outs)
        # octaves were computed top-down; stack bottom-up
        c = torch.cat([o[..., :t_min] for o in reversed(outs)], dim=1)
        c = c * self.inv_sqrt_len[None, :, None]
        if c.shape[-1] >= n_frames:
            return c[..., :n_frames]
        return torch.nn.functional.pad(c, (0, n_frames - c.shape[-1]), mode="replicate")


BACKENDS = ("librosa", "torch")


def get_backend(name: str, device: str | None = None) -> CQTBackend:
    if name == "librosa":
        return LibrosaBackend()
    if name == "torch":
        try:
            return TorchBackend(device=device)
        except ImportError as e:
            raise RuntimeError("torch backend needs the 'gpu' extra: uv sync --extra gpu") from e
    raise ValueError(f"unknown CQT backend {name!r}; choose from {BACKENDS}")


def cqt_magnitude(y: np.ndarray, spec: CQTSpec, backend: str = "librosa") -> np.ndarray:
    return get_backend(backend).magnitude(y, spec)
