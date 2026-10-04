"""Start the server with ``python -m src.backend``; PORT defaults to 3000."""

import os

import uvicorn

if __name__ == '__main__':
    uvicorn.run('src.backend.main:app', host='127.0.0.1', port=int(os.getenv('PORT', '3000')))
