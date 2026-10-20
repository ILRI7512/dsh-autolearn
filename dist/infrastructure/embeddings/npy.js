/**
 * NumPy .npy 读写（仅 float32 二维、C 序）。
 *
 * 旧版索引是 numpy 落盘的 vectors.npy；为了「旧数据可直接读、新数据旧版可读」，
 * 这里手写该子集格式（无任何 numpy 依赖）。
 */
const MAGIC = Uint8Array.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]); // \x93NUMPY
export function writeNpy(matrix) {
    const { rows, cols, data } = matrix;
    if (data.length !== rows * cols)
        throw new Error(`npy: data length ${data.length} != ${rows}x${cols}`);
    const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
    // 10 = magic(6) + version(2) + header-length(2)
    let padded = dict;
    while ((10 + padded.length + 1) % 64 !== 0)
        padded += ' ';
    const header = `${padded}\n`;
    const headerBytes = Buffer.from(header, 'latin1');
    const out = Buffer.alloc(10 + headerBytes.length + data.length * 4);
    Buffer.from(MAGIC).copy(out, 0);
    out.writeUInt8(1, 6);
    out.writeUInt8(0, 7);
    out.writeUInt16LE(headerBytes.length, 8);
    headerBytes.copy(out, 10);
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 10 + headerBytes.length);
    return out;
}
export function readNpy(buffer) {
    if (buffer.length < 10)
        throw new Error('npy: header too short');
    for (let i = 0; i < MAGIC.length; i += 1) {
        if (buffer[i] !== MAGIC[i])
            throw new Error('npy: bad magic');
    }
    const major = buffer.readUInt8(6);
    let headerLength;
    let offset;
    if (major === 1) {
        headerLength = buffer.readUInt16LE(8);
        offset = 10;
    }
    else if (major === 2 || major === 3) {
        headerLength = Number(buffer.readUInt32LE(8));
        offset = 12;
    }
    else {
        throw new Error(`npy: unsupported version ${major}`);
    }
    const header = buffer.subarray(offset, offset + headerLength).toString('latin1');
    const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
    if (!shapeMatch?.[1])
        throw new Error('npy: missing shape');
    const dims = shapeMatch[1]
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => Number.parseInt(part, 10));
    if (dims.some((dim) => Number.isNaN(dim)))
        throw new Error('npy: invalid shape');
    const rows = dims[0] ?? 0;
    const cols = dims.length > 1 ? dims[1] : 1;
    if (!/['"]descr['"]:\s*['"]<f4['"]/.test(header))
        throw new Error('npy: only float32 little-endian is supported');
    if (/'fortran_order':\s*True/.test(header))
        throw new Error('npy: fortran order is not supported');
    const dataOffset = offset + headerLength;
    const expected = rows * cols * 4;
    if (buffer.length - dataOffset < expected)
        throw new Error('npy: truncated data section');
    const copy = Buffer.from(buffer.subarray(dataOffset, dataOffset + expected));
    const data = new Float32Array(copy.buffer, copy.byteOffset, rows * cols);
    return { rows, cols, data };
}
