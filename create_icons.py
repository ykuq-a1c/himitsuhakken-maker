"""
create_icons.py — アイコン生成スクリプト
このファイルと同じフォルダで実行してください。
  python create_icons.py
icons/ フォルダに icon16.png / icon48.png / icon128.png が生成されます。
"""
import struct, zlib, os

def make_png(size, r, g, b):
    """シンプルな単色正方形 PNG を生成"""
    width = height = size

    # ピクセルデータ（各行の先頭に filter byte 0x00 を付ける）
    raw = b''
    for _ in range(height):
        raw += b'\x00'
        for _ in range(width):
            raw += bytes([r, g, b])

    def chunk(name, data):
        body = name + data
        return (
            struct.pack('>I', len(data))
            + body
            + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)
        )

    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    idat_data = zlib.compress(raw, 9)

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr_data)
        + chunk(b'IDAT', idat_data)
        + chunk(b'IEND', b'')
    )

if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    # 紫系の色でアイコン生成
    for size in [16, 48, 128]:
        data = make_png(size, 120, 40, 200)
        path = os.path.join('icons', f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  作成: {path}')
    print('完了！ icons/ フォルダにアイコンが生成されました。')
