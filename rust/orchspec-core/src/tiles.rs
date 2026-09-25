//! Tile I/O and the LOD pyramid (docs/bundle-format.md "Spectrogram tiles"), mirroring
//! `src/orchspec/dsp/tiles.py`. Arrays are frame-major u8: byte = frame * n_bins + bin.

use crate::manifest::{Lod, Tile, TileEncoding};
use flate2::read::GzDecoder;
use flate2::{Compression, GzBuilder};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

/// zlib level used by the Python writer (docs: ~30 % of raw at ~180 MB/s).
pub const GZIP_LEVEL: u32 = 3;

pub fn decode_tile(data: &[u8], enc: TileEncoding) -> io::Result<Vec<u8>> {
    match enc {
        TileEncoding::Raw => Ok(data.to_vec()),
        TileEncoding::Gzip => {
            let mut out = Vec::with_capacity(data.len() * 4);
            GzDecoder::new(data).read_to_end(&mut out)?;
            Ok(out)
        }
    }
}

/// gzip member with mtime 0 (reproducible). The deflate stream itself may differ from
/// CPython's zlib; the decoded bytes are what the format fixes.
pub fn encode_tile(raw: &[u8], enc: TileEncoding) -> io::Result<Vec<u8>> {
    match enc {
        TileEncoding::Raw => Ok(raw.to_vec()),
        TileEncoding::Gzip => {
            let mut w = GzBuilder::new().mtime(0).write(Vec::new(), Compression::new(GZIP_LEVEL));
            w.write_all(raw)?;
            w.finish()
        }
    }
}

pub fn tile_suffix(enc: TileEncoding) -> &'static str {
    match enc {
        TileEncoding::Raw => ".u8",
        TileEncoding::Gzip => ".u8.gz",
    }
}

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// One tile's decoded bytes, size-checked (`n_frames * n_bins`).
pub fn read_tile(root: &Path, t: &Tile, n_bins: usize, enc: TileEncoding) -> io::Result<Vec<u8>> {
    crate::manifest::check_rel_path(&t.path).map_err(|e| bad(e.to_string()))?;
    let raw = decode_tile(&fs::read(root.join(&t.path))?, enc)?;
    if raw.len() != t.n_frames as usize * n_bins {
        return Err(bad(format!(
            "{}: {} bytes, expected {}",
            t.path,
            raw.len(),
            t.n_frames as usize * n_bins
        )));
    }
    Ok(raw)
}

/// A whole level reassembled from its tiles: `n_frames * n_bins` bytes.
pub fn read_level(root: &Path, lod: &Lod, n_bins: usize, enc: TileEncoding) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(lod.n_frames as usize * n_bins);
    for t in &lod.tiles {
        out.extend_from_slice(&read_tile(root, t, n_bins, enc)?);
    }
    Ok(out)
}

/// Elementwise max of frame pairs; an odd last frame stands alone (`lod_reduce = "max"`).
pub fn pool_max(level: &[u8], n_bins: usize) -> Vec<u8> {
    let frames = level.len() / n_bins;
    let out_frames = frames.div_ceil(2);
    let mut out = vec![0u8; out_frames * n_bins];
    for f in 0..out_frames {
        let a = &level[2 * f * n_bins..(2 * f + 1) * n_bins];
        let b = if 2 * f + 1 < frames { &level[(2 * f + 1) * n_bins..(2 * f + 2) * n_bins] } else { a };
        for (o, (x, y)) in out[f * n_bins..(f + 1) * n_bins].iter_mut().zip(a.iter().zip(b)) {
            *o = (*x).max(*y);
        }
    }
    out
}

/// Frame count per level; levels are generated until one fits in a single tile.
pub fn lod_frame_counts(n_frames: u64, tile_frames: u64) -> Vec<u64> {
    let mut counts = vec![n_frames];
    while *counts.last().unwrap() > tile_frames {
        let c = counts.last().unwrap().div_ceil(2);
        counts.push(c);
    }
    counts
}

/// All levels from level 0.
pub fn pyramid(level0: &[u8], n_bins: usize, tile_frames: u64) -> Vec<Vec<u8>> {
    let counts = lod_frame_counts((level0.len() / n_bins) as u64, tile_frames);
    let mut levels = vec![level0.to_vec()];
    for _ in 1..counts.len() {
        let next = pool_max(levels.last().unwrap(), n_bins);
        levels.push(next);
    }
    levels
}

/// Writes one level as tiles under `root/prefix/L<level>/` and returns its manifest entry.
pub fn write_level(
    root: &Path,
    prefix: &str,
    level: u32,
    data: &[u8],
    n_bins: usize,
    tile_frames: u64,
    enc: TileEncoding,
) -> io::Result<Lod> {
    fs::create_dir_all(root.join(prefix).join(format!("L{level}")))?;
    let frames = (data.len() / n_bins) as u64;
    let mut tiles = Vec::new();
    let mut start = 0u64;
    let mut i = 0u32;
    while start < frames {
        let n = tile_frames.min(frames - start);
        let chunk = &data[start as usize * n_bins..(start + n) as usize * n_bins];
        let rel = format!("{prefix}/L{level}/{i:05}{}", tile_suffix(enc));
        fs::write(root.join(&rel), encode_tile(chunk, enc)?)?;
        tiles.push(Tile { index: i, start_frame: start, n_frames: n, path: rel });
        start += n;
        i += 1;
    }
    Ok(Lod { level, hop_factor: 1 << level, n_frames: frames, tiles })
}
