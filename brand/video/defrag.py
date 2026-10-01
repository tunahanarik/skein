"""Rewrites a fragmented MP4 (MediaRecorder output) as a plain MP4 with one moov and one mdat.

Samples are copied byte for byte (no re-encode); the sample tables (stts, ctts, stss, stsz, stsc,
stco) are rebuilt from the fragments. Single video track only, which is what the intro has.
Usage: python defrag.py in.mp4 out.mp4
"""
import struct
import sys

CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex", "edts", "dinf"}


def parse(b, off=0, end=None):
    end = len(b) if end is None else end
    out = []
    while off + 8 <= end:
        size, typ = struct.unpack(">I4s", b[off:off + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", b[off + 8:off + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - off
        t = typ.decode("latin1")
        kids = parse(b, off + hdr, off + size) if t in CONTAINERS else None
        out.append({"t": t, "off": off, "size": size, "hdr": hdr, "kids": kids})
        off += size
    return out


def find(boxes, path):
    for bx in boxes:
        if bx["t"] == path[0]:
            return bx if len(path) == 1 else find(bx["kids"] or [], path[1:])
    return None


def box(t, payload):
    return struct.pack(">I4s", 8 + len(payload), t.encode()) + payload


def full(t, version, flags, payload):
    return box(t, struct.pack(">I", (version << 24) | flags) + payload)


def main(src, dst):
    d = open(src, "rb").read()
    top = parse(d)
    moov = find(top, ["moov"])
    trex = find(top, ["moov", "mvex", "trex"])
    dflt_dur = dflt_size = dflt_flags = 0
    if trex:
        o = trex["off"] + 8
        _, _, _, dflt_dur, dflt_size, dflt_flags = struct.unpack(">IIIIII", d[o:o + 24])

    samples = []  # (data bytes, duration, flags, cts)
    for m in [bx for bx in top if bx["t"] == "moof"]:
        traf = find(m["kids"], ["traf"])
        tfhd = find(traf["kids"], ["tfhd"])
        o = tfhd["off"] + 8
        vf = struct.unpack(">I", d[o:o + 4])[0]
        fl = vf & 0xFFFFFF
        p = o + 8  # skip version/flags and track id
        base = m["off"]
        if fl & 0x1:
            base = struct.unpack(">Q", d[p:p + 8])[0]
            p += 8
        if fl & 0x2:
            p += 4
        dur = dflt_dur
        size = dflt_size
        sflags = dflt_flags
        if fl & 0x8:
            dur = struct.unpack(">I", d[p:p + 4])[0]
            p += 4
        if fl & 0x10:
            size = struct.unpack(">I", d[p:p + 4])[0]
            p += 4
        if fl & 0x20:
            sflags = struct.unpack(">I", d[p:p + 4])[0]
            p += 4
        for trun in [k for k in traf["kids"] if k["t"] == "trun"]:
            o = trun["off"] + 8
            vf = struct.unpack(">I", d[o:o + 4])[0]
            version, tf = vf >> 24, vf & 0xFFFFFF
            count = struct.unpack(">I", d[o + 4:o + 8])[0]
            p = o + 8
            data_off = 0
            first_flags = None
            if tf & 0x1:
                data_off = struct.unpack(">i", d[p:p + 4])[0]
                p += 4
            if tf & 0x4:
                first_flags = struct.unpack(">I", d[p:p + 4])[0]
                p += 4
            pos = base + data_off
            for i in range(count):
                sd, ss, sf, sc = dur, size, sflags, 0
                if tf & 0x100:
                    sd = struct.unpack(">I", d[p:p + 4])[0]
                    p += 4
                if tf & 0x200:
                    ss = struct.unpack(">I", d[p:p + 4])[0]
                    p += 4
                if tf & 0x400:
                    sf = struct.unpack(">I", d[p:p + 4])[0]
                    p += 4
                if tf & 0x800:
                    sc = struct.unpack(">i" if version else ">I", d[p:p + 4])[0]
                    p += 4
                if i == 0 and first_flags is not None:
                    sf = first_flags
                samples.append((d[pos:pos + ss], sd, sf, sc))
                pos += ss

    n = len(samples)
    total = sum(s[1] for s in samples)
    mdhd = find(moov["kids"], ["trak", "mdia", "mdhd"])
    mv = d[mdhd["off"] + 8]
    track_ts = struct.unpack(">I", d[mdhd["off"] + (20 if mv == 0 else 28):][:4])[0]
    mvhd = find(moov["kids"], ["mvhd"])
    vv = d[mvhd["off"] + 8]
    movie_ts = struct.unpack(">I", d[mvhd["off"] + (20 if vv == 0 else 28):][:4])[0]
    movie_dur = total * movie_ts // track_ts

    def raw(bx):
        return bytearray(d[bx["off"]:bx["off"] + bx["size"]])

    def set_dur(b, v0_off, v1_off, value):
        # version 0 boxes hold 32 bit times, version 1 boxes 64 bit (MediaRecorder writes version 1)
        if b[8] == 0:
            struct.pack_into(">I", b, v0_off, value)
        else:
            struct.pack_into(">Q", b, v1_off, value)

    mvhd_b = raw(mvhd)
    set_dur(mvhd_b, 24, 32, movie_dur)
    tkhd_b = raw(find(moov["kids"], ["trak", "tkhd"]))
    set_dur(tkhd_b, 28, 36, movie_dur)
    mdhd_b = raw(mdhd)
    set_dur(mdhd_b, 24, 32, total)

    # stts (run length of durations)
    runs = []
    for s in samples:
        if runs and runs[-1][1] == s[1]:
            runs[-1][0] += 1
        else:
            runs.append([1, s[1]])
    stts = full("stts", 0, 0, struct.pack(">I", len(runs)) + b"".join(struct.pack(">II", c, v) for c, v in runs))
    ctts = b""
    if any(s[3] for s in samples):
        cr = []
        for s in samples:
            if cr and cr[-1][1] == s[3]:
                cr[-1][0] += 1
            else:
                cr.append([1, s[3]])
        ctts = full("ctts", 0, 0, struct.pack(">I", len(cr)) + b"".join(struct.pack(">II", c, v & 0xFFFFFFFF) for c, v in cr))
    sync = [i + 1 for i, s in enumerate(samples) if not (s[2] & 0x10000)]
    stss = full("stss", 0, 0, struct.pack(">I", len(sync)) + b"".join(struct.pack(">I", i) for i in sync))
    stsz = full("stsz", 0, 0, struct.pack(">II", 0, n) + b"".join(struct.pack(">I", len(s[0])) for s in samples))
    stsc = full("stsc", 0, 0, struct.pack(">IIII", 1, 1, n, 1))
    stsd = bytes(raw(find(moov["kids"], ["trak", "mdia", "minf", "stbl", "stsd"])))

    def build(stco_off):
        stco = full("stco", 0, 0, struct.pack(">II", 1, stco_off))
        stbl = box("stbl", stsd + stts + ctts + stss + stsc + stsz + stco)
        minf_kids = [k for k in find(moov["kids"], ["trak", "mdia", "minf"])["kids"] if k["t"] != "stbl"]
        minf = box("minf", b"".join(bytes(raw(k)) for k in minf_kids) + stbl)
        hdlr = bytes(raw(find(moov["kids"], ["trak", "mdia", "hdlr"])))
        mdia = box("mdia", bytes(mdhd_b) + hdlr + minf)
        trak = box("trak", bytes(tkhd_b) + mdia)
        return box("moov", bytes(mvhd_b) + trak)

    ftyp = box("ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2avc1mp41")
    moov_len = len(build(0))
    mdat_payload = b"".join(s[0] for s in samples)
    first = len(ftyp) + moov_len + 8
    out = ftyp + build(first) + box("mdat", mdat_payload)
    open(dst, "wb").write(out)
    fps = n / (total / track_ts)
    print(f"{n} frames, {total / track_ts:.2f} s, {fps:.2f} fps, {len(sync)} keyframes, {len(out)} bytes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
