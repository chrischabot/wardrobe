//! What an uploaded file is, read from its bytes and never from what the client declared: JPEG, PNG or
//! WebP, its dimensions, whether it is animated, whether it holds image data at all, whether its
//! metadata carries a location, and a copy of it without metadata. Nothing is decoded or re-encoded:
//! the files are walked segment by segment (JPEG markers, PNG chunks, RIFF chunks), so the pixels of a
//! stripped copy are exactly the pixels supplied.
//!
//! A stripped copy keeps what is needed to show the picture as taken (the JFIF header, the colour
//! profile, Adobe colour transform, quantization and Huffman tables, frame and scan data, PNG's
//! critical and colour chunks, WebP's image, alpha and colour-profile chunks) and drops every other
//! metadata block: Exif (and with it any GPS block), XMP, IPTC, comments, PNG text and time chunks,
//! WebP EXIF and XMP chunks, and anything after the end of the image (an iPhone JPEG appends further
//! images there, each with its own Exif). A JPEG's Exif orientation is the one value carried over, as a
//! new minimal Exif block that holds nothing else, so a portrait photograph is not shown on its side.

/// What [`probe`] read from a file's structure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub content_type: &'static str,
    pub width: u32,
    pub height: u32,
    /// An animated PNG or WebP.
    pub animated: bool,
    /// The file carries image data (a JPEG scan with entropy-coded bytes, a PNG `IDAT`, a WebP
    /// `VP8 `/`VP8L` chunk), not only headers.
    pub has_image_data: bool,
}

/// The structure of `bytes` if it is a JPEG, PNG or WebP this module can walk to its end.
pub fn probe(bytes: &[u8]) -> Option<Probe> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        probe_jpeg(bytes)
    } else if bytes.starts_with(PNG_SIGNATURE) {
        probe_png(bytes)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        probe_webp(bytes)
    } else {
        None
    }
}

/// A copy of `bytes` without metadata (see the module documentation), or `None` when the file
/// cannot be walked to its end. Stripping a stripped copy changes nothing.
pub fn strip(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        strip_jpeg(bytes)
    } else if bytes.starts_with(PNG_SIGNATURE) {
        strip_png(bytes)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        strip_webp(bytes)
    } else {
        None
    }
}

/// Whether the file's metadata names a location: an Exif block anywhere in the file (appended images
/// included) with a GPS directory, a PNG `eXIf` or WebP `EXIF` chunk with one, or XMP naming a GPS
/// latitude or longitude.
pub fn has_location(bytes: &[u8]) -> bool {
    const EXIF: &[u8] = b"Exif\0\0";
    let mut i = 0;
    while let Some(at) = find(&bytes[i..], EXIF) {
        let start = i + at + EXIF.len();
        if tiff_has_gps(&bytes[start..]) {
            return true;
        }
        i = start;
    }
    if find(bytes, b"GPSLatitude").is_some() || find(bytes, b"GPSLongitude").is_some() {
        return true;
    }
    if bytes.starts_with(PNG_SIGNATURE) {
        if let Some(chunks) = png_chunks(bytes) {
            return chunks.iter().any(|c| c.kind == *b"eXIf" && tiff_has_gps(c.data));
        }
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        if let Some(chunks) = riff_chunks(bytes) {
            return chunks.iter().any(|c| c.kind == *b"EXIF" && tiff_has_gps(c.data.strip_prefix(EXIF).unwrap_or(c.data)));
        }
    }
    false
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ─────────────────────────────── TIFF (Exif) ───────────────────────────────

/// The entries of a TIFF header's first directory: `(tag, type, count, value field)` and whether the
/// file is little-endian.
fn tiff_ifd0(t: &[u8]) -> Option<(bool, Vec<(u16, u16, u32, [u8; 4])>)> {
    let le = match t.get(..4)? {
        [b'I', b'I', 0x2A, 0x00] => true,
        [b'M', b'M', 0x00, 0x2A] => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = t.get(at..at.checked_add(2)?)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = t.get(at..at.checked_add(4)?)?;
        Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
    };
    let offset = usize::try_from(u32_at(4)?).ok()?;
    let count = u16_at(offset)? as usize;
    let mut entries = Vec::with_capacity(count.min(256));
    for n in 0..count.min(1024) {
        let at = offset.checked_add(2)?.checked_add(12 * n)?;
        let value = t.get(at.checked_add(8)?..at.checked_add(12)?)?;
        entries.push((u16_at(at)?, u16_at(at + 2)?, u32_at(at + 4)?, [value[0], value[1], value[2], value[3]]));
    }
    Some((le, entries))
}

/// Tag 0x8825 (the GPS directory) in the first directory.
fn tiff_has_gps(t: &[u8]) -> bool {
    tiff_ifd0(t).map_or(false, |(_, entries)| entries.iter().any(|e| e.0 == 0x8825))
}

/// Tag 0x0112 (orientation, one SHORT from 1 to 8) in the first directory.
fn tiff_orientation(t: &[u8]) -> Option<u16> {
    let (le, entries) = tiff_ifd0(t)?;
    let (_, kind, count, v) = entries.into_iter().find(|e| e.0 == 0x0112)?;
    if kind != 3 || count != 1 {
        return None;
    }
    let o = if le { u16::from_le_bytes([v[0], v[1]]) } else { u16::from_be_bytes([v[0], v[1]]) };
    (1..=8).contains(&o).then_some(o)
}

// ─────────────────────────────── JPEG ───────────────────────────────

enum JpegItem<'a> {
    /// A marker segment: marker and payload (after the length field).
    Segment(u8, &'a [u8]),
    /// A scan: its header payload and the entropy-coded bytes after it.
    Scan(&'a [u8], &'a [u8]),
    /// A marker without a payload (restart markers, TEM).
    Standalone(u8),
}

/// Every marker from after SOI to EOI; `None` when the file ends before EOI or a length is wrong.
fn jpeg_items(b: &[u8]) -> Option<Vec<JpegItem<'_>>> {
    let mut items = Vec::new();
    let mut i = 2;
    loop {
        if *b.get(i)? != 0xFF {
            return None;
        }
        while *b.get(i)? == 0xFF {
            i += 1;
        }
        let marker = b[i];
        i += 1;
        match marker {
            0xD9 => return Some(items),
            0x01 | 0xD0..=0xD7 => items.push(JpegItem::Standalone(marker)),
            0x00 | 0xD8 => return None,
            _ => {
                let len = u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]) as usize;
                if len < 2 || i + len > b.len() {
                    return None;
                }
                let payload = &b[i + 2..i + len];
                i += len;
                if marker == 0xDA {
                    // Entropy-coded data runs to the next marker: 0xFF followed by anything but a
                    // stuffed zero or a restart marker.
                    let start = i;
                    loop {
                        if *b.get(i)? == 0xFF {
                            let next = *b.get(i + 1)?;
                            if next == 0x00 || (0xD0..=0xD7).contains(&next) {
                                i += 2;
                                continue;
                            }
                            break;
                        }
                        i += 1;
                    }
                    items.push(JpegItem::Scan(payload, &b[start..i]));
                } else {
                    items.push(JpegItem::Segment(marker, payload));
                }
            }
        }
    }
}

/// A frame header (SOFn) that declares a picture: precision 8, 12 or 16, non-zero dimensions, one to
/// four components whose sampling factors are 1 to 4 and quantization table index at most 3, and a
/// length that matches. Its components as (ID, quantization table), or `None`.
fn jpeg_frame(p: &[u8]) -> Option<(u32, u32, Vec<(u8, u8)>)> {
    let (precision, height, width, n) = (*p.first()?, u16::from_be_bytes([*p.get(1)?, *p.get(2)?]), u16::from_be_bytes([*p.get(3)?, *p.get(4)?]), *p.get(5)? as usize);
    if ![8, 12, 16].contains(&precision) || height == 0 || width == 0 || !(1..=4).contains(&n) || p.len() != 6 + 3 * n {
        return None;
    }
    let mut components: Vec<(u8, u8)> = Vec::with_capacity(n);
    for c in p[6..].chunks(3) {
        let (h, v) = (c[1] >> 4, c[1] & 0x0F);
        if !(1..=4).contains(&h) || !(1..=4).contains(&v) || c[2] > 3 || components.iter().any(|(id, _)| *id == c[0]) {
            return None;
        }
        components.push((c[0], c[2]));
    }
    Some((u32::from(width), u32::from(height), components))
}

/// A scan header (SOS) naming one to four of the frame's components, with a length that matches.
/// The quantization tables of the components it names, or `None`.
fn jpeg_scan_tables(p: &[u8], components: &[(u8, u8)]) -> Option<Vec<u8>> {
    let n = usize::from(*p.first()?);
    if !(1..=4).contains(&n) || p.len() != 1 + 2 * n + 3 {
        return None;
    }
    p[1..1 + 2 * n].chunks(2).map(|c| components.iter().find(|(id, _)| *id == c[0]).map(|(_, tq)| *tq)).collect()
}

/// The destinations a valid DQT segment defines, or `None`.
fn dqt_destinations(p: &[u8]) -> Option<Vec<u8>> {
    if !dqt_ok(p) {
        return None;
    }
    let (mut out, mut i) = (Vec::new(), 0);
    while i < p.len() {
        out.push(p[i] & 0x0F);
        i += 1 + 64 * (1 + usize::from(p[i] >> 4));
    }
    Some(out)
}

fn probe_jpeg(b: &[u8]) -> Option<Probe> {
    let items = jpeg_items(b)?;
    // The frame, and whether it is lossless (SOF3, 7, 11, 15: no quantization tables).
    let mut frame: Option<(u32, u32, Vec<(u8, u8)>, bool)> = None;
    let mut defined = [false; 4];
    let (mut scans, mut has_image_data) = (0, false);
    for item in &items {
        match item {
            JpegItem::Segment(0xDB, p) => {
                for tq in dqt_destinations(p)? {
                    defined[usize::from(tq)] = true;
                }
            }
            JpegItem::Segment(m @ 0xC0..=0xCF, p) if !matches!(m, 0xC4 | 0xC8 | 0xCC) => {
                // One frame per image.
                if frame.is_some() {
                    return None;
                }
                let (w, h, components) = jpeg_frame(p)?;
                frame = Some((w, h, components, matches!(m, 0xC3 | 0xC7 | 0xCB | 0xCF)));
            }
            JpegItem::Scan(header, entropy) => {
                let (_, _, components, lossless) = frame.as_ref()?;
                let tables = jpeg_scan_tables(header, components)?;
                // A quantized scan's tables are defined before it (before or after the frame header).
                if !lossless && tables.iter().any(|tq| !defined[usize::from(*tq)]) {
                    return None;
                }
                scans += 1;
                has_image_data |= !entropy.is_empty();
            }
            _ => {}
        }
    }
    let (width, height, _, _) = frame?;
    Some(Probe { content_type: "image/jpeg", width, height, animated: false, has_image_data: has_image_data && scans > 0 })
}

/// What a stripped JPEG does with a segment: keep this payload, drop the segment, or refuse the file.
enum Kept {
    Keep(Vec<u8>),
    Drop,
    Refuse,
}

/// Quantization tables (DQT) filling the payload exactly: each a precision/destination byte (8- or
/// 16-bit, destination 0 to 3) and 64 entries.
fn dqt_ok(p: &[u8]) -> bool {
    let mut i = 0;
    while i < p.len() {
        let (pq, tq) = (p[i] >> 4, p[i] & 0x0F);
        if pq > 1 || tq > 3 {
            return false;
        }
        i += 1 + 64 * (1 + usize::from(pq));
    }
    i == p.len() && !p.is_empty()
}

/// Huffman tables (DHT) filling the payload exactly: each a class/destination byte, 16 counts and
/// as many symbols as the counts add up to (at most 256).
fn dht_ok(p: &[u8]) -> bool {
    let mut i = 0;
    while i < p.len() {
        let (tc, th) = (p[i] >> 4, p[i] & 0x0F);
        let Some(counts) = p.get(i + 1..i + 17) else { return false };
        let symbols: usize = counts.iter().map(|&c| usize::from(c)).sum();
        if tc > 1 || th > 3 || symbols > 256 {
            return false;
        }
        i += 17 + symbols;
    }
    i == p.len() && !p.is_empty()
}

/// The payload a stripped JPEG keeps for a segment, an allowlist: the JFIF header and the Adobe
/// colour-transform marker rebuilt from their fixed fields alone (no JFIF thumbnail, nothing after
/// the fields, so no metadata can ride inside them); the quantization, Huffman and arithmetic-coding
/// tables, the restart interval, the line count and the frame header, each only when its fields fill
/// its payload exactly (the file is refused otherwise, so nothing can follow them). Every other
/// segment (Exif, XMP, IPTC, the ICC colour profile, comments, other APPn, reserved JPGn extensions,
/// anything unknown) is dropped. Scans are kept separately.
fn jpeg_kept(marker: u8, payload: &[u8]) -> Kept {
    let check = |ok: bool| if ok { Kept::Keep(payload.to_vec()) } else { Kept::Refuse };
    match marker {
        // "JFIF\0", version, units, X and Y density (12 bytes), then a 0×0 thumbnail.
        0xE0 if payload.len() >= 14 && payload.starts_with(b"JFIF\0") => {
            let mut p = payload[..12].to_vec();
            p.extend_from_slice(&[0, 0]);
            Kept::Keep(p)
        }
        // "Adobe", version, two flag words and the transform byte (12 bytes), nothing more.
        0xEE if payload.len() >= 12 && payload.starts_with(b"Adobe") => Kept::Keep(payload[..12].to_vec()),
        0xDB => check(dqt_ok(payload)),
        0xC4 => check(dht_ok(payload)),
        // DAC: class/destination and value pairs.
        0xCC => check(!payload.is_empty() && payload.len() % 2 == 0 && payload.chunks(2).all(|c| c[0] >> 4 <= 1 && c[0] & 0x0F <= 3)),
        // DNL and DRI: one 16-bit value.
        0xDC | 0xDD => check(payload.len() == 2),
        // SOF0 to SOF15 (C4, C8 and CC are not frame headers).
        0xC0..=0xCF if marker != 0xC8 => check(jpeg_frame(payload).is_some()),
        _ => Kept::Drop,
    }
}

fn push_segment(out: &mut Vec<u8>, marker: u8, payload: &[u8]) {
    out.extend_from_slice(&[0xFF, marker]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
}

/// A minimal big-endian Exif block holding only an orientation.
fn exif_orientation_only(o: u16) -> Vec<u8> {
    let mut e = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01".to_vec();
    e.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]);
    e.extend_from_slice(&o.to_be_bytes());
    e.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    e
}

fn strip_jpeg(b: &[u8]) -> Option<Vec<u8>> {
    let items = jpeg_items(b)?;
    let orientation = items.iter().find_map(|item| match item {
        JpegItem::Segment(0xE1, p) if p.starts_with(b"Exif\0\0") => Some(tiff_orientation(&p[6..])),
        _ => None,
    });
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&[0xFF, 0xD8]);
    let mut orientation_written = false;
    let mut write_orientation = |out: &mut Vec<u8>| {
        if !orientation_written {
            orientation_written = true;
            if let Some(Some(o)) = orientation.filter(|o| *o != Some(1)) {
                push_segment(out, 0xE1, &exif_orientation_only(o));
            }
        }
    };
    for (n, item) in items.iter().enumerate() {
        match item {
            JpegItem::Segment(m, p) => {
                let kept = match jpeg_kept(*m, p) {
                    Kept::Keep(k) => Some(k),
                    Kept::Drop => None,
                    Kept::Refuse => return None,
                };
                // JFIF stays the first segment; the orientation follows it.
                if !(n == 0 && *m == 0xE0 && kept.is_some()) {
                    write_orientation(&mut out);
                }
                if let Some(k) = kept {
                    push_segment(&mut out, *m, &k);
                }
            }
            JpegItem::Scan(header, entropy) => {
                // The scan header's fields fill it exactly (component count, selectors, spectral
                // selection and approximation), so nothing rides after them.
                let n = usize::from(*header.first()?);
                if !(1..=4).contains(&n) || header.len() != 1 + 2 * n + 3 {
                    return None;
                }
                write_orientation(&mut out);
                push_segment(&mut out, 0xDA, header);
                out.extend_from_slice(entropy);
            }
            JpegItem::Standalone(m) => out.extend_from_slice(&[0xFF, *m]),
        }
    }
    write_orientation(&mut out);
    out.extend_from_slice(&[0xFF, 0xD9]);
    Some(out)
}

// ─────────────────────────────── PNG ───────────────────────────────

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

struct Chunk<'a> {
    kind: [u8; 4],
    data: &'a [u8],
}

/// Every chunk up to and including IEND; `None` when the file ends first.
fn png_chunks(b: &[u8]) -> Option<Vec<Chunk<'_>>> {
    let mut chunks = Vec::new();
    let mut i = PNG_SIGNATURE.len();
    loop {
        let len = u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize;
        let kind: [u8; 4] = b.get(i + 4..i + 8)?.try_into().ok()?;
        let end = i.checked_add(12)?.checked_add(len)?;
        if end > b.len() {
            return None;
        }
        chunks.push(Chunk { kind, data: &b[i + 8..i + 8 + len] });
        i = end;
        if kind == *b"IEND" {
            return Some(chunks);
        }
    }
}

fn probe_png(b: &[u8]) -> Option<Probe> {
    let chunks = png_chunks(b)?;
    let ihdr = chunks.first().filter(|c| c.kind == *b"IHDR" && c.data.len() == 13)?;
    let width = u32::from_be_bytes(ihdr.data[0..4].try_into().ok()?);
    let height = u32::from_be_bytes(ihdr.data[4..8].try_into().ok()?);
    let (depth, colour, compression, filter, interlace) = (ihdr.data[8], ihdr.data[9], ihdr.data[10], ihdr.data[11], ihdr.data[12]);
    // The header's fields as the PNG specification allows them, and a palette for an indexed image.
    let depth_ok = match colour {
        0 => [1, 2, 4, 8, 16].contains(&depth),
        3 => [1, 2, 4, 8].contains(&depth),
        2 | 4 | 6 => [8, 16].contains(&depth),
        _ => false,
    };
    let limit = 0x7FFF_FFFF;
    if width == 0 || height == 0 || width > limit || height > limit || !depth_ok || compression != 0 || filter != 0 || interlace > 1 {
        return None;
    }
    if colour == 3 && !chunks.iter().any(|c| c.kind == *b"PLTE") {
        return None;
    }
    Some(Probe {
        content_type: "image/png",
        width,
        height,
        animated: chunks.iter().any(|c| c.kind == *b"acTL"),
        has_image_data: chunks.iter().any(|c| c.kind == *b"IDAT" && !c.data.is_empty()),
    })
}

/// The PNG chunks a stripped copy keeps: the critical chunks, transparency, and the colour and
/// display chunks a viewer needs to show the picture as taken. Everything else, known or not (text,
/// time, Exif, the ICC profile, C2PA/JUMBF provenance, animation, private chunks), is dropped.
const PNG_KEEPS: &[&[u8; 4]] = &[b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"cICP", b"mDCV", b"cLLI", b"bKGD", b"pHYs"];

/// Whether a kept chunk's data has exactly the length its fields take, for an image of colour type
/// `colour` with `palette` entries (so no bytes can follow its fields). Image data is any length.
fn png_length_ok(kind: &[u8; 4], len: usize, colour: u8, palette: usize) -> bool {
    match kind {
        b"IHDR" => len == 13,
        b"PLTE" => matches!(colour, 2 | 3 | 6) && len % 3 == 0 && (3..=768).contains(&len),
        b"IEND" => len == 0,
        b"IDAT" => true,
        b"tRNS" => match colour {
            0 => len == 2,
            2 => len == 6,
            3 => (1..=palette).contains(&len),
            _ => false,
        },
        b"cHRM" => len == 32,
        b"gAMA" | b"cICP" => len == 4,
        b"sBIT" => len == [1, 0, 3, 3, 2, 0, 4].get(usize::from(colour)).copied().unwrap_or(0),
        b"sRGB" => len == 1,
        b"mDCV" => len == 24,
        b"cLLI" => len == 8,
        b"bKGD" => len == if colour == 3 { 1 } else if colour == 2 || colour == 6 { 6 } else { 2 },
        b"pHYs" => len == 9,
        _ => false,
    }
}

/// The CRC-32 a PNG chunk carries (ISO 3309), over its type and data.
const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

fn png_crc(kind: &[u8], data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in kind.iter().chain(data) {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

fn push_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&png_crc(kind, data).to_be_bytes());
}

/// A copy holding only the kept chunks, each rebuilt from its type and data with its CRC computed
/// here (nothing of the supplied chunk framing is copied). A kept ancillary chunk whose length is not
/// its fields' is dropped; a critical chunk of the wrong length, or an unknown critical chunk, means
/// a viewer could not show the file, so it is not walked.
fn strip_png(b: &[u8]) -> Option<Vec<u8>> {
    let chunks = png_chunks(b)?;
    let ihdr = chunks.first().filter(|c| c.kind == *b"IHDR" && c.data.len() == 13)?;
    let colour = ihdr.data[9];
    let palette = chunks.iter().find(|c| c.kind == *b"PLTE").map_or(0, |c| c.data.len() / 3);
    let mut out = PNG_SIGNATURE.to_vec();
    for c in &chunks {
        let critical = c.kind[0].is_ascii_uppercase();
        if PNG_KEEPS.contains(&&c.kind) && png_length_ok(&c.kind, c.data.len(), colour, palette) {
            push_png_chunk(&mut out, &c.kind, c.data);
        } else if critical {
            return None;
        }
    }
    Some(out)
}

// ─────────────────────────────── WebP ───────────────────────────────

/// Every chunk of the RIFF container (its declared size bounds the walk; bytes after it are ignored).
fn riff_chunks(b: &[u8]) -> Option<Vec<Chunk<'_>>> {
    let size = u32::from_le_bytes(b.get(4..8)?.try_into().ok()?) as usize;
    let end = size.checked_add(8)?;
    if end > b.len() || size < 4 {
        return None;
    }
    let mut chunks = Vec::new();
    let mut i = 12;
    while i < end {
        let kind: [u8; 4] = b.get(i..i + 4)?.try_into().ok()?;
        let len = u32::from_le_bytes(b.get(i + 4..i + 8)?.try_into().ok()?) as usize;
        let data_end = i.checked_add(8)?.checked_add(len)?;
        let padded = data_end + (len & 1);
        if data_end > end {
            return None;
        }
        chunks.push(Chunk { kind, data: &b[i + 8..data_end] });
        i = padded;
    }
    (!chunks.is_empty()).then_some(chunks)
}

/// The dimensions in a `VP8 ` (key frame, start code) or `VP8L` (signature) chunk's frame header, if
/// it holds one followed by image data.
fn webp_frame(c: &Chunk<'_>) -> Option<(u32, u32)> {
    let d = c.data;
    match &c.kind {
        b"VP8 " => {
            if d.len() <= 10 || d[0] & 0x01 != 0 || d[3..6] != [0x9D, 0x01, 0x2A] {
                return None;
            }
            Some((u32::from(u16::from_le_bytes([d[6], d[7]]) & 0x3FFF), u32::from(u16::from_le_bytes([d[8], d[9]]) & 0x3FFF)))
        }
        b"VP8L" => {
            if d.len() <= 5 || d[0] != 0x2F {
                return None;
            }
            let bits = u32::from_le_bytes([d[1], d[2], d[3], d[4]]);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        _ => None,
    }
}

fn probe_webp(b: &[u8]) -> Option<Probe> {
    let chunks = riff_chunks(b)?;
    let first = &chunks[0];
    let d = first.data;
    let u24 = |at: usize| -> Option<u32> { Some(u32::from(*d.get(at)?) | u32::from(*d.get(at + 1)?) << 8 | u32::from(*d.get(at + 2)?) << 16) };
    // The stripped copy keeps every `VP8 `/`VP8L` chunk, so a still image may hold only the one
    // frame checked here: a second, unchecked frame is not an image this server accepts.
    let frames = chunks.iter().filter(|c| c.kind == *b"VP8 " || c.kind == *b"VP8L").count();
    match &first.kind {
        b"VP8 " | b"VP8L" => {
            // A simple WebP is its one frame: an extended header, alpha, colour profile or
            // animation chunk beside it is refused.
            if frames != 1 || chunks.iter().skip(1).any(|c| SIMPLE_REFUSES.contains(&&c.kind)) {
                return None;
            }
            let (width, height) = webp_frame(first)?;
            Some(Probe { content_type: "image/webp", width, height, animated: false, has_image_data: true })
        }
        b"VP8X" => {
            // The extended header is exactly its flags, three reserved bytes and the canvas size.
            if d.len() != 10 {
                return None;
            }
            let (width, height) = (u24(4)? + 1, u24(7)? + 1);
            let animated = d.first()? & 0x02 != 0 || chunks.iter().any(|c| c.kind == *b"ANIM" || c.kind == *b"ANMF");
            if animated {
                // Refused at finalization whatever its frames hold.
                return Some(Probe { content_type: "image/webp", width, height, animated, has_image_data: chunks.iter().any(|c| c.kind == *b"ANMF" && !c.data.is_empty()) });
            }
            // A still extended WebP: its one frame must parse and fill the canvas exactly.
            if frames > 1 {
                return None;
            }
            let frame = chunks.iter().find(|c| c.kind == *b"VP8 " || c.kind == *b"VP8L");
            let has_image_data = match frame.map(webp_frame) {
                None | Some(None) => false,
                Some(Some(dims)) if dims == (width, height) => true,
                Some(Some(_)) => return None,
            };
            Some(Probe { content_type: "image/webp", width, height, animated, has_image_data })
        }
        _ => None,
    }
}

/// The WebP chunks a stripped copy keeps: the extended header (rebuilt), the image and its alpha.
/// Everything else (EXIF, XMP, the ICC profile, animation, unknown chunks) is dropped.
const WEBP_KEEPS: &[&[u8; 4]] = &[b"VP8X", b"VP8 ", b"VP8L", b"ALPH"];
/// Chunks a simple (`VP8 `/`VP8L` first) WebP may not hold beside its frame.
const SIMPLE_REFUSES: &[&[u8; 4]] = &[b"VP8X", b"ALPH", b"ICCP", b"ANIM", b"ANMF"];

fn push_riff_chunk(body: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    body.extend_from_slice(kind);
    body.extend_from_slice(&(data.len() as u32).to_le_bytes());
    body.extend_from_slice(data);
    if data.len() % 2 == 1 {
        body.push(0);
    }
}

/// A copy holding only the kept chunks, each rebuilt from its type and data with zero padding. The
/// extended header is rebuilt from its fields: only the alpha flag survives (Exif, XMP, ICC and
/// animation are no longer announced), the reserved bytes are zero, and the canvas size is copied;
/// a header of any other length is not walked.
fn strip_webp(b: &[u8]) -> Option<Vec<u8>> {
    let chunks = riff_chunks(b)?;
    let mut body = b"WEBP".to_vec();
    for c in chunks.iter().filter(|c| WEBP_KEEPS.contains(&&c.kind)) {
        if c.kind == *b"VP8X" {
            if c.data.len() != 10 {
                return None;
            }
            let mut header = vec![c.data[0] & 0x10, 0, 0, 0];
            header.extend_from_slice(&c.data[4..10]);
            push_riff_chunk(&mut body, b"VP8X", &header);
        } else {
            push_riff_chunk(&mut body, &c.kind, c.data);
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An Exif block (with its "Exif\0\0" prefix) whose first directory holds an orientation and,
    /// when asked, a GPS directory pointer.
    fn exif(little_endian: bool, orientation: u16, gps: bool) -> Vec<u8> {
        let n: u16 = if gps { 2 } else { 1 };
        let w16 = |v: u16| if little_endian { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if little_endian { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut t = b"Exif\0\0".to_vec();
        t.extend_from_slice(if little_endian { b"II\x2a\0" } else { b"MM\0\x2a" });
        t.extend_from_slice(&w32(8));
        t.extend_from_slice(&w16(n));
        t.extend_from_slice(&w16(0x0112));
        t.extend_from_slice(&w16(3));
        t.extend_from_slice(&w32(1));
        t.extend_from_slice(&w16(orientation));
        t.extend_from_slice(&[0, 0]);
        if gps {
            t.extend_from_slice(&w16(0x8825));
            t.extend_from_slice(&w16(4));
            t.extend_from_slice(&w32(1));
            t.extend_from_slice(&w32(40));
        }
        t.extend_from_slice(&w32(0));
        t.extend_from_slice(b"GPS-DIRECTORY-BYTES");
        t
    }

    fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        push_segment(&mut out, marker, payload);
        out
    }

    /// A structurally complete JPEG: JFIF, the given extra segments, tables, a frame of `w`×`h`, one
    /// scan with stuffed bytes and a restart marker, EOI, then `trailer`.
    fn jpeg(w: u16, h: u16, extra: &[Vec<u8>], trailer: &[u8]) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        b.extend(segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0"));
        for e in extra {
            b.extend_from_slice(e);
        }
        b.extend(segment(0xDB, &[0u8; 65]));
        let mut sof = vec![8];
        sof.extend_from_slice(&h.to_be_bytes());
        sof.extend_from_slice(&w.to_be_bytes());
        sof.extend_from_slice(&[1, 1, 0x11, 0]);
        b.extend(segment(0xC0, &sof));
        b.extend(segment(0xC4, &[0u8; 17]));
        b.extend(segment(0xDA, &[1, 1, 0, 0, 0x3F, 0]));
        b.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56]);
        b.extend_from_slice(&[0xFF, 0xD9]);
        b.extend_from_slice(trailer);
        b
    }

    #[test]
    fn a_jpeg_loses_its_metadata_and_appended_images_but_keeps_its_pixels_and_orientation() {
        let gps = exif(false, 6, true);
        let xmp = b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>51,30N</exif:GPSLatitude></x:xmpmeta>".to_vec();
        let icc = b"ICC_PROFILE\0\x01\x01profile".to_vec();
        let appended = jpeg(8, 8, &[segment(0xE1, &exif(true, 1, true))], &[]);
        let file = jpeg(640, 480, &[segment(0xE1, &gps), segment(0xE1, &xmp), segment(0xE2, &icc), segment(0xFE, b"a comment"), segment(0xED, b"Photoshop 3.0\0IPTC"), segment(0xF3, b"JPG3 GPS-IN-AN-EXTENSION")], &appended);
        let p = probe(&file).unwrap();
        assert_eq!((p.content_type, p.width, p.height, p.animated, p.has_image_data), ("image/jpeg", 640, 480, false, true));
        assert!(has_location(&file));

        let clean = strip(&file).unwrap();
        assert!(!has_location(&clean), "no GPS, XMP or appended Exif survives");
        assert_eq!(probe(&clean).unwrap(), p, "the same picture");
        assert!(find(&clean, b"ICC_PROFILE").is_none(), "the colour profile is dropped: it can carry any bytes");
        for gone in [&b"a comment"[..], b"IPTC", b"GPS-DIRECTORY-BYTES", b"xmpmeta", b"GPS-IN-AN-EXTENSION"] {
            assert!(find(&clean, gone).is_none(), "{}", String::from_utf8_lossy(gone));
        }
        // The scan bytes are exactly as supplied, and nothing follows the end of the image.
        assert!(find(&clean, &[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD9]).is_some());
        assert!(clean.ends_with(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD9]));
        // The orientation (6: rotate 90°) is the only Exif value carried over, right after JFIF.
        let items = jpeg_items(&clean).unwrap();
        assert!(matches!(items[0], JpegItem::Segment(0xE0, _)));
        match items[1] {
            JpegItem::Segment(0xE1, p) => {
                assert_eq!(tiff_orientation(&p[6..]), Some(6));
                assert_eq!(tiff_ifd0(&p[6..]).unwrap().1.len(), 1);
            }
            _ => panic!("the orientation block follows JFIF"),
        }
        assert_eq!(strip(&clean).unwrap(), clean, "stripping twice changes nothing");
    }

    #[test]
    fn retained_jfif_and_adobe_segments_keep_only_their_fixed_fields() {
        // Location hidden after an Adobe marker's fields, and in a JFIF thumbnail and its tail.
        let mut adobe = b"Adobe\0\x64\0\0\0\0\x01".to_vec();
        adobe.extend_from_slice(&exif(false, 1, true));
        adobe.extend_from_slice(b"GPS-AFTER-ADOBE");
        let mut jfif = b"JFIF\0\x01\x02\x01\0\x48\0\x48\x01\x01".to_vec();
        jfif.extend_from_slice(&[9, 9, 9]);
        jfif.extend_from_slice(b"GPS-IN-A-THUMBNAIL");
        let file = jpeg(64, 48, &[segment(0xEE, &adobe), segment(0xE0, &jfif)], &[]);
        let p = probe(&file).unwrap();
        let clean = strip(&file).unwrap();
        for gone in [&b"GPS-AFTER-ADOBE"[..], b"GPS-DIRECTORY-BYTES", b"GPS-IN-A-THUMBNAIL", b"Exif"] {
            assert!(find(&clean, gone).is_none(), "{}", String::from_utf8_lossy(gone));
        }
        let kept: Vec<(u8, Vec<u8>)> = jpeg_items(&clean).unwrap().iter().filter_map(|i| match i {
            JpegItem::Segment(m @ (0xE0 | 0xEE), p) => Some((*m, p.to_vec())),
            _ => None,
        }).collect();
        assert_eq!(kept, vec![
            (0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0".to_vec()),
            (0xEE, b"Adobe\0\x64\0\0\0\0\x01".to_vec()),
            (0xE0, b"JFIF\0\x01\x02\x01\0\x48\0\x48\0\0".to_vec()),
        ], "each keeps exactly its fixed fields, the thumbnail emptied");
        assert_eq!(probe(&clean).unwrap(), p);
        // Too short to hold their fields: dropped.
        let short = jpeg(64, 48, &[segment(0xEE, b"Adobe\0\x64"), segment(0xE0, b"JFIF\0\x01")], &[]);
        let clean = strip(&short).unwrap();
        assert!(find(&clean, b"Adobe").is_none() && jpeg_items(&clean).unwrap().iter().filter(|i| matches!(i, JpegItem::Segment(0xE0, _))).count() == 1);
    }

    #[test]
    fn an_upright_jpeg_gets_no_exif_and_broken_jpegs_are_not_walked() {
        let file = jpeg(64, 64, &[segment(0xE1, &exif(true, 1, false))], &[]);
        assert!(!has_location(&file));
        let clean = strip(&file).unwrap();
        assert!(find(&clean, b"Exif").is_none());
        // Headers only: a scan with no entropy-coded bytes.
        let mut empty = file[..file.len() - 9].to_vec();
        empty.extend_from_slice(&[0xFF, 0xD9]);
        assert!(!probe(&empty).unwrap().has_image_data);
        // Truncated before EOI, a bad length, no frame.
        assert!(probe(&file[..file.len() - 2]).is_none());
        assert!(strip(&file[..40]).is_none());
        assert!(probe(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01, 0xFF, 0xD9]).is_none());
        assert!(probe(&[0xFF, 0xD8, 0xFF, 0xD9]).is_none(), "no frame, no dimensions");
        // Frame and scan headers must declare a picture: components, lengths, tables first.
        let swap = |from: &[u8], to: &[u8]| {
            let at = file.windows(from.len()).position(|w| w == from).unwrap();
            let mut f = file[..at].to_vec();
            f.extend_from_slice(to);
            f.extend_from_slice(&file[at + from.len()..]);
            f
        };
        let sof = [0xFF, 0xC0, 0x00, 0x0B, 8, 0, 64, 0, 64, 1, 1, 0x11, 0];
        assert!(probe(&swap(&sof, &[0xFF, 0xC0, 0x00, 0x07, 8, 0, 64, 0, 64])).is_none(), "a frame with no component definitions");
        assert!(probe(&swap(&sof, &[0xFF, 0xC0, 0x00, 0x0B, 8, 0, 64, 0, 64, 1, 1, 0x55, 0])).is_none(), "sampling factor 5");
        assert!(probe(&swap(&sof, &[0xFF, 0xC0, 0x00, 0x0B, 9, 0, 64, 0, 64, 1, 1, 0x11, 0])).is_none(), "precision 9");
        let sos = [0xFF, 0xDA, 0x00, 0x08, 1, 1, 0, 0, 0x3F, 0];
        assert!(probe(&swap(&sos, &[0xFF, 0xDA, 0x00, 0x08, 1, 7, 0, 0, 0x3F, 0])).is_none(), "a scan of a component the frame lacks");
        let dqt_at = file.windows(2).position(|w| w == [0xFF, 0xDB]).unwrap();
        let mut no_tables = file[..dqt_at].to_vec();
        no_tables.extend_from_slice(&file[dqt_at + 69..]);
        assert!(probe(&no_tables).is_none(), "no quantization table");
        // A table may follow the frame header, as long as it comes before the scan that uses it.
        let dqt = segment(0xDB, &[0u8; 65]);
        let sos_at = no_tables.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap();
        let mut late = no_tables[..sos_at].to_vec();
        late.extend_from_slice(&dqt);
        late.extend_from_slice(&no_tables[sos_at..]);
        assert!(probe(&late).unwrap().has_image_data, "tables after the frame, before the scan");
        let eoi_at = no_tables.len() - 2;
        let mut after = no_tables[..eoi_at].to_vec();
        after.extend_from_slice(&dqt);
        after.extend_from_slice(&[0xFF, 0xD9]);
        assert!(probe(&after).is_none(), "a table after the scan that needed it");
        // A lossless frame (SOF3) uses no quantization tables.
        let mut lossless = no_tables.clone();
        let sof_at = lossless.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        lossless[sof_at + 1] = 0xC3;
        assert!(probe(&lossless).unwrap().has_image_data, "a lossless JPEG");
    }

    #[test]
    fn kept_jpeg_tables_must_be_exactly_their_fields() {
        // Bytes after a table's fields (here location text) mean the file is not walked, so they
        // can never ride into the stripped copy.
        let file = jpeg(64, 64, &[], &[]);
        let swap = |from: &[u8], to: &[u8]| {
            let at = file.windows(from.len()).position(|w| w == from).unwrap();
            let mut f = file[..at].to_vec();
            f.extend_from_slice(to);
            f.extend_from_slice(&file[at + from.len()..]);
            f
        };
        let with = |head: &[u8], extra: &[u8]| [head, extra].concat();
        let dqt = segment(0xDB, &[0u8; 65]);
        let dht = segment(0xC4, &[0u8; 17]);
        for (from, to) in [
            (dqt.clone(), segment(0xDB, &with(&[0u8; 65], b"GPS 51N"))),
            (dht.clone(), segment(0xC4, &with(&[0u8; 17], b"GPS 51N"))),
            (dht.clone(), [dht.clone(), segment(0xDD, b"\0\x10GPS")].concat()),
        ] {
            assert!(strip(&swap(&from, &to)).is_none());
        }
        let mut second = vec![0u8; 65];
        second[0] = 1;
        assert!(strip(&swap(&dqt, &segment(0xDB, &[vec![0u8; 65], second].concat()))).is_some(), "two whole tables in one segment");
        assert!(strip(&swap(&dht, &[dht.clone(), segment(0xDD, b"\0\x10")].concat())).is_some(), "a restart interval");
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(data);
        c.extend_from_slice(&[0, 0, 0, 0]);
        c
    }

    #[test]
    fn a_png_loses_its_text_time_and_exif_chunks() {
        let mut ihdr = 300u32.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&200u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut file = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &ihdr), png_chunk(b"eXIf", &exif(true, 1, true)[6..]), png_chunk(b"tEXt", b"Comment\0hello"), png_chunk(b"caBX", b"jumb c2pa GPSLatitude 51,30N"), png_chunk(b"iCCP", b"icc"), png_chunk(b"prVt", b"lat=51.5 lon=-0.12"), png_chunk(b"IDAT", b"pixels"), png_chunk(b"tIME", &[7; 7]), png_chunk(b"IEND", b"")] {
            file.extend(c);
        }
        file.extend_from_slice(b"trailing");
        let p = probe(&file).unwrap();
        assert_eq!((p.content_type, p.width, p.height, p.animated, p.has_image_data), ("image/png", 300, 200, false, true));
        assert!(has_location(&file));
        let clean = strip(&file).unwrap();
        assert!(!has_location(&clean));
        let kinds: Vec<[u8; 4]> = png_chunks(&clean).unwrap().iter().map(|c| c.kind).collect();
        assert_eq!(kinds, [*b"IHDR", *b"IDAT", *b"IEND"], "only the allowlisted chunks: provenance, private chunks and the colour profile are dropped too");
        assert!(find(&clean, b"lat=51.5").is_none() && find(&clean, b"c2pa").is_none());
        // Every kept chunk carries the CRC computed over its type and data.
        let mut at = PNG_SIGNATURE.len();
        while at < clean.len() {
            let len = u32::from_be_bytes(clean[at..at + 4].try_into().unwrap()) as usize;
            let crc = u32::from_be_bytes(clean[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc, png_crc(&clean[at + 4..at + 8], &clean[at + 8..at + 8 + len]));
            at += 12 + len;
        }
        assert_eq!(png_crc(b"IEND", b""), 0xAE42_6082, "the CRC of IEND");
        // An unknown critical chunk is not walked.
        let mut critical = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &ihdr), png_chunk(b"QXYZ", b"?"), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
            critical.extend(c);
        }
        assert!(strip(&critical).is_none());
        let mut iend = Vec::new();
        push_png_chunk(&mut iend, b"IEND", b"");
        assert!(clean.ends_with(&iend));
        // A kept chunk with bytes after its fields (location after a gamma value) is dropped; a
        // palette of the wrong length means the file is not walked.
        let mut gamma = 45455u32.to_be_bytes().to_vec();
        gamma.extend_from_slice(b"GPS 51N");
        let mut padded = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &ihdr), png_chunk(b"gAMA", &gamma), png_chunk(b"pHYs", &[0, 0, 0x0B, 0x13, 0, 0, 0x0B, 0x13, 1]), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
            padded.extend(c);
        }
        let clean = strip(&padded).unwrap();
        assert_eq!(png_chunks(&clean).unwrap().iter().map(|c| c.kind).collect::<Vec<_>>(), [*b"IHDR", *b"pHYs", *b"IDAT", *b"IEND"]);
        assert!(find(&clean, b"GPS").is_none());
        let mut indexed_header = ihdr.clone();
        indexed_header[9] = 3;
        let mut bad_palette = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &indexed_header), png_chunk(b"PLTE", b"\0\0\0\0GPS"), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
            bad_palette.extend(c);
        }
        assert!(strip(&bad_palette).is_none());
        let mut animated = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &ihdr), png_chunk(b"acTL", &[0; 8]), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
            animated.extend(c);
        }
        assert!(probe(&animated).unwrap().animated);
        assert!(probe(&file[..file.len() - 20]).is_none(), "no IEND");
        // The header's fields as the specification allows them.
        for (n, bad) in [(8usize, 3u8), (9, 1), (10, 1), (11, 1), (12, 2)] {
            let mut header = ihdr.clone();
            header[n] = bad;
            let mut f = PNG_SIGNATURE.to_vec();
            for c in [png_chunk(b"IHDR", &header), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
                f.extend(c);
            }
            assert!(probe(&f).is_none(), "IHDR byte {n} = {bad}");
        }
        let mut indexed = ihdr.clone();
        indexed[9] = 3;
        let mut f = PNG_SIGNATURE.to_vec();
        for c in [png_chunk(b"IHDR", &indexed), png_chunk(b"IDAT", b"p"), png_chunk(b"IEND", b"")] {
            f.extend(c);
        }
        assert!(probe(&f).is_none(), "an indexed image without a palette");
    }

    fn riff(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        for (kind, data) in chunks {
            body.extend_from_slice(*kind);
            body.extend_from_slice(&(data.len() as u32).to_le_bytes());
            body.extend_from_slice(data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }

    #[test]
    fn a_webp_loses_its_exif_and_xmp_chunks_and_their_flags() {
        // VP8X: flags Exif|XMP|alpha, canvas 1024×768.
        let mut vp8x = vec![0x08 | 0x04 | 0x10, 0, 0, 0];
        vp8x.extend_from_slice(&[0xFF, 0x03, 0x00, 0xFF, 0x02, 0x00]);
        let mut vp8 = vec![0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A];
        vp8.extend_from_slice(&1024u16.to_le_bytes());
        vp8.extend_from_slice(&768u16.to_le_bytes());
        vp8.extend_from_slice(b"frame");
        let file = riff(&[(b"VP8X", vp8x.clone()), (b"ALPH", b"a".to_vec()), (b"VP8 ", vp8.clone()), (b"EXIF", exif(false, 1, true)), (b"XMP ", b"<x:xmpmeta/>".to_vec()), (b"GPSx", b"lat=51.5".to_vec())]);
        let p = probe(&file).unwrap();
        assert_eq!((p.content_type, p.width, p.height, p.animated, p.has_image_data), ("image/webp", 1024, 768, false, true));
        assert!(has_location(&file));
        let clean = strip(&file).unwrap();
        assert!(!has_location(&clean));
        let chunks = riff_chunks(&clean).unwrap();
        assert_eq!(chunks.iter().map(|c| c.kind).collect::<Vec<_>>(), [*b"VP8X", *b"ALPH", *b"VP8 "], "unknown chunks are dropped too");
        assert_eq!(chunks[0].data[0], 0x10, "only the alpha flag is left");
        assert_eq!(u32::from_le_bytes(clean[4..8].try_into().unwrap()) as usize, clean.len() - 8);
        assert_eq!(probe(&clean).unwrap(), p);
        // A simple lossy WebP has no metadata; its copy is the same file.
        let simple = riff(&[(b"VP8 ", vp8.clone())]);
        assert_eq!(strip(&simple).unwrap(), simple);
        let mut anim = vec![0x02, 0, 0, 0];
        anim.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        assert!(probe(&riff(&[(b"VP8X", anim), (b"ANIM", vec![0; 6])])).unwrap().animated);
        // An extended WebP's frame must parse and fill its canvas: a one-byte frame holds no image,
        // and a frame larger than the canvas is not walked.
        let broken = riff(&[(b"VP8X", vp8x.clone()), (b"VP8 ", vec![0x10])]);
        assert!(!probe(&broken).unwrap().has_image_data);
        let mut huge = vp8.clone();
        huge[6..8].copy_from_slice(&9000u16.to_le_bytes());
        assert!(probe(&riff(&[(b"VP8X", vp8x), (b"VP8 ", huge.clone())])).is_none());
        assert_eq!(probe(&riff(&[(b"VP8 ", huge)])).unwrap().width, 9000, "a simple WebP's frame is its size");
        assert!(probe(&riff(&[(b"VP8 ", vec![0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A, 1, 0, 1, 0])])).is_none(), "a frame header with no data");
        // A still image holds one frame: a valid first frame does not carry an unchecked second.
        let mut ext = vec![0x10, 0, 0, 0];
        ext.extend_from_slice(&[0xFF, 0x03, 0x00, 0xFF, 0x02, 0x00]);
        assert!(probe(&riff(&[(b"VP8X", ext.clone()), (b"VP8 ", vp8.clone()), (b"VP8 ", vec![0x10])])).is_none());
        assert!(probe(&riff(&[(b"VP8X", ext), (b"VP8 ", vp8.clone()), (b"VP8L", vec![0x2F, 0xFF, 0xFF, 0xFF, 0x0F, 0])])).is_none());
        assert!(probe(&riff(&[(b"VP8 ", vp8.clone()), (b"VP8 ", vec![0x10])])).is_none());
        // A simple WebP holds nothing else: no extended header, alpha, colour profile or animation
        // beside its frame.
        for (kind, data) in [(b"ANIM", vec![0; 6]), (b"ANMF", vec![0; 24]), (b"VP8X", vec![0; 10]), (b"ALPH", vec![0]), (b"ICCP", b"profile".to_vec())] {
            assert!(probe(&riff(&[(b"VP8 ", vp8.clone()), (kind, data)])).is_none(), "{}", String::from_utf8_lossy(kind));
        }
        // Chunks the copy drops anyway (here XMP) do not make it invalid.
        assert!(probe(&riff(&[(b"VP8 ", vp8.clone()), (b"XMP ", b"<x/>".to_vec())])).is_some());
        // The extended header is exactly ten bytes: location after its fields is not walked. The
        // colour profile is dropped and its flag cleared.
        let mut long = vec![0x10, 0, 0, 0, 0xFF, 0x03, 0x00, 0xFF, 0x02, 0x00];
        long.extend_from_slice(b"GPS 51N");
        let smuggled = riff(&[(b"VP8X", long), (b"VP8 ", vp8.clone())]);
        assert!(probe(&smuggled).is_none() && strip(&smuggled).is_none());
        let with_icc = riff(&[(b"VP8X", vec![0x20 | 0x10, 0, 0, 0, 0xFF, 0x03, 0x00, 0xFF, 0x02, 0x00]), (b"ICCP", b"profile GPS 51N".to_vec()), (b"VP8 ", vp8.clone())]);
        let clean = strip(&with_icc).unwrap();
        let chunks = riff_chunks(&clean).unwrap();
        assert_eq!((chunks.iter().map(|c| c.kind).collect::<Vec<_>>(), chunks[0].data[0]), (vec![*b"VP8X", *b"VP8 "], 0x10));
        assert!(find(&clean, b"GPS").is_none());
    }

    #[test]
    fn other_files_are_not_images() {
        assert!(probe(b"GIF89a....").is_none());
        assert!(strip(b"<svg/>").is_none());
        assert!(probe(b"RIFF\x04\0\0\0WEBP").is_none());
    }
}
