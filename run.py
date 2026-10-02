"""Launch the Python backend or its tests using the project's virtual environment."""

import os
from pathlib import Path
import subprocess
import sys


def main():
    """Use the project virtualenv, then dispatch server, tests, or private export.

    Server mode binds loopback only. --reload watches backend source; test and
    export execute separate Python processes and return their exit status.
    """
    root = Path(__file__).resolve().parent
    os.chdir(root)
    environment = root / '.venv-backend'
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if python.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        return subprocess.call([str(python), str(root / 'run.py'), *sys.argv[1:]])
    if sys.argv[1:2] == ['test']:
        return subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'])
    if sys.argv[1:2] == ['export']:
        return subprocess.call([sys.executable, '-m', 'scripts.export_sqlite_state', *sys.argv[2:]])
    import uvicorn
    from src.backend.config import ROOT
    uvicorn.run('src.backend.main:app', host='127.0.0.1', port=int(os.getenv('PORT', '3000')),
                reload='--reload' in sys.argv, reload_dirs=[str(ROOT / 'src/backend')] if '--reload' in sys.argv else None)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
