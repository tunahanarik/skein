"""Writes WebCodecs H.264 samples (length prefixed, avc format) into a plain MP4: one moov, one mdat.
Usage: python mux.py samples.bin meta.json out.mp4"""
import base64, json, struct, sys


def box(t, p):
    return struct.pack(">I4s", 8 + len(p), t.encode()) + p


def full(t, v, f, p):
    return box(t, struct.pack(">I", (v << 24) | f) + p)


def main(src, meta_path, dst):
    data = open(src, "rb").read()
    m = json.load(open(meta_path))
    fps, sizes, keys, w, h = m["fps"], m["sizes"], m["keys"], m["width"], m["height"]
    avcc = base64.b64decode(m["desc"])
    n, ts = len(sizes), fps * 1000
    dur_track, dur_movie = n * 1000, n * 1000 * 1000 // ts
    matrix = struct.pack(">9I", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
    mvhd = full("mvhd", 0, 0, struct.pack(">IIII", 0, 0, 1000, dur_movie) + struct.pack(">IH", 0x10000, 0x100) + b"\0" * 10 + matrix + b"\0" * 24 + struct.pack(">I", 2))
    tkhd = full("tkhd", 0, 3, struct.pack(">IIIII", 0, 0, 1, 0, dur_movie) + b"\0" * 8 + struct.pack(">HHHH", 0, 0, 0, 0) + matrix + struct.pack(">II", w << 16, h << 16))
    mdhd = full("mdhd", 0, 0, struct.pack(">IIII", 0, 0, ts, dur_track) + struct.pack(">HH", 0x55C4, 0))
    hdlr = full("hdlr", 0, 0, b"\0" * 4 + b"vide" + b"\0" * 12 + b"VideoHandler\0")
    vmhd = full("vmhd", 0, 1, b"\0" * 8)
    dinf = box("dinf", full("dref", 0, 0, struct.pack(">I", 1) + full("url ", 0, 1, b"")))
    avc1 = box("avc1", b"\0" * 6 + struct.pack(">H", 1) + b"\0" * 16 + struct.pack(">HHIIIH", w, h, 0x480000, 0x480000, 0, 1) + b"\0" * 32 + struct.pack(">Hh", 0x18, -1) + box("avcC", avcc))
    stsd = full("stsd", 0, 0, struct.pack(">I", 1) + avc1)
    stts = full("stts", 0, 0, struct.pack(">III", 1, n, 1000))
    stss = full("stss", 0, 0, struct.pack(">I", len(keys)) + b"".join(struct.pack(">I", k + 1) for k in keys))
    stsc = full("stsc", 0, 0, struct.pack(">IIII", 1, 1, n, 1))
    stsz = full("stsz", 0, 0, struct.pack(">II", 0, n) + b"".join(struct.pack(">I", s) for s in sizes))
    ftyp = box("ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2avc1mp41")

    def moov(off):
        stbl = box("stbl", stsd + stts + stss + stsc + stsz + full("stco", 0, 0, struct.pack(">II", 1, off)))
        return box("moov", mvhd + box("trak", tkhd + box("mdia", mdhd + hdlr + box("minf", vmhd + dinf + stbl))))

    off = len(ftyp) + len(moov(0)) + 8
    open(dst, "wb").write(ftyp + moov(off) + box("mdat", data))
    print(f"{n} frames at {fps} fps, {n / fps:.2f} s, {len(keys)} keyframes, {(len(data) + off) / 1e6:.1f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:4])
