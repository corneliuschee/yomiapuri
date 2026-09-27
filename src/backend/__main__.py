"""Start the local FastAPI server with the configured port."""

import os

import uvicorn

if __name__ == '__main__':
    uvicorn.run('src.backend.main:app', host='127.0.0.1', port=int(os.getenv('PORT', '3000')))
