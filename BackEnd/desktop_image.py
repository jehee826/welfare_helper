"""메모리 안의 단일 PNG만 검증하며 이미지나 질문을 저장하지 않는다."""
import base64
import binascii
import struct
import zlib
from BackEnd.core.execution import InferenceBodyLimit as DesktopBodyLimit


def image_bytes(encoded: str) -> bytes:
    if len(encoded) > 2 * 1024 * 1024:
        raise ValueError("image_size_limit")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("invalid_image") from None
    if len(data) > 1536 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("invalid_image")
    offset, compressed, dimensions, ended = 8, bytearray(), None, False
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("invalid_image")
        chunk = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        if zlib.crc32(kind + chunk) & 0xffffffff != crc:
            raise ValueError("invalid_image")
        if dimensions is None and kind != b"IHDR":
            raise ValueError("invalid_image")
        if kind == b"IHDR":
            if dimensions is not None or size != 13:
                raise ValueError("invalid_image")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunk)
            if not (1 <= width <= 1280 and 1 <= height <= 800 and depth == 8 and color in (2, 6)
                    and compression == filtering == interlace == 0):
                raise ValueError("image_dimensions_or_format")
            dimensions = width, height, 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.extend(chunk)
        elif kind == b"IEND":
            ended = size == 0 and end == len(data)
            break
        elif kind not in (b"sRGB", b"gAMA", b"cHRM", b"pHYs", b"sBIT"):
            # 애니메이션·텍스트 메타데이터·첨부 데이터는 받지 않는다.
            raise ValueError("image_metadata_not_allowed")
        offset = end
    if not ended or not dimensions or not compressed:
        raise ValueError("invalid_image")
    width, height, channels = dimensions
    expected = height * (1 + width * channels)
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(compressed, expected + 1)
        if len(pixels) != expected or not decoder.eof or decoder.unused_data:
            raise ValueError("invalid_image")
        if any(pixels[row * (1 + width * channels)] > 4 for row in range(height)):
            raise ValueError("invalid_image")
    except zlib.error:
        raise ValueError("invalid_image") from None
    return data
