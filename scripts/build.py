'''Package the extension using only Python's standard library.'''

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
	'''Write a versioned archive containing only installable extension files.'''
	root = Path(__file__).resolve().parents[1]
	manifest = json.loads((root / 'manifest.json').read_text())
	destination = root / 'dist'
	destination.mkdir(exist_ok=True)
	archive = destination / f'translate-in-context-menu-{manifest["version"]}.zip'
	files = [root / 'manifest.json']
	for directory in ('src', 'icons'):
		files.extend(path for path in (root / directory).rglob('*') if path.is_file())
	with ZipFile(archive, 'w', compression=ZIP_DEFLATED) as output:
		for path in sorted(files):
			output.write(path, path.relative_to(root))
	print(archive)


if __name__ == '__main__':
	main()
