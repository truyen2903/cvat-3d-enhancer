#!/usr/bin/env python3
"""Package the production extension, ready for Chrome/Brave Load unpacked."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
version = json.loads((ROOT / 'package.json').read_text())['version']
manifest = json.loads((DIST / 'manifest.json').read_text())
if manifest.get('version') != version or manifest.get('manifest_version') != 3:
    raise SystemExit('Build the extension first; package and manifest versions must match.')

# Validate every directly referenced extension entry point before creating a download.
references = [manifest['background']['service_worker'], manifest['action']['default_popup']]
references += list(manifest.get('icons', {}).values())
for script in manifest.get('content_scripts', []):
    references += script.get('js', []) + script.get('css', [])
for reference in references:
    path = (DIST / reference).resolve()
    if not path.is_relative_to(DIST.resolve()) or not path.is_file():
        raise SystemExit(f'Missing or invalid extension resource: {reference}')

files = sorted(path for path in DIST.rglob('*') if path.is_file())
if any(path.is_symlink() or path.suffix == '.map' for path in files):
    raise SystemExit('Release bundles must not contain symlinks or source maps.')

output = ROOT / 'release'
output.mkdir(exist_ok=True)
archive = output / f'meow-v{version}.zip'
instructions = f'''Meow v{version} — Chrome / Brave

CÀI ĐẶT / INSTALL
1. Giải nén ZIP và giữ thư mục meow ở vị trí cố định.
   Extract the ZIP and keep the meow folder in a permanent location.
2. Mở chrome://extensions hoặc brave://extensions.
3. Bật Developer mode / Chế độ dành cho nhà phát triển.
4. Chọn Load unpacked / Tải tiện ích đã giải nén → chọn thư mục meow
   (thư mục chứa manifest.json).
5. Với CVAT công ty: mở popup Meow, nhập URL CVAT và chọn Add & Activate Link,
   sau đó cấp quyền truy cập domain và tải lại tab CVAT.
6. Mở CVAT Settings → Workspace để bật/tắt từng tính năng.

Không cần Node.js, npm hoặc build lại mã nguồn.
Node.js, npm and a source build are NOT required.

CẬP NHẬT / UPDATE
Thay nội dung trong thư mục meow đã nạp bằng bản mới, bấm Reload tại trang
Extensions và tải lại tab CVAT. Giữ nguyên đường dẫn thư mục đã nạp.
Replace the contents of the existing meow folder, reload the extension and CVAT tab.

Source and compatibility: https://github.com/truyen2903/cvat-3d-enhancer
'''
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in files:
        bundle.write(path, 'meow/' + path.relative_to(DIST).as_posix())
    bundle.writestr('meow/INSTALL.txt', instructions)

with zipfile.ZipFile(archive) as bundle:
    if bundle.testzip() is not None:
        raise SystemExit('ZIP integrity validation failed.')
    packaged = json.loads(bundle.read('meow/manifest.json'))
    if packaged['version'] != version:
        raise SystemExit('Incorrect packaged manifest version.')
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / f'meow-v{version}.sha256').write_text(f'{checksum}  {archive.name}\n')
print(f'{archive.relative_to(ROOT)} ({archive.stat().st_size:,} bytes)')
print(f'SHA256 {checksum}')
