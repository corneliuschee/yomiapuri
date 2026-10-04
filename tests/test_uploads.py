"""Check upload limits without opening the app or allocating large test files."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from src.backend.api.uploads import MAX_UPLOAD_BYTES, read_upload


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_file(self):
        for missing in (None, object()):
            with self.subTest(file=missing), self.assertRaisesRegex(ValueError, 'Choose a file'):
                await read_upload(missing)

    async def test_reads_at_most_limit_plus_one_byte(self):
        file = SimpleNamespace(read=AsyncMock(return_value=b'book'))
        self.assertEqual(await read_upload(file), b'book')
        self.assertEqual(MAX_UPLOAD_BYTES, 60 * 1024 * 1024)
        file.read.assert_awaited_once_with(MAX_UPLOAD_BYTES + 1)

    async def test_size_boundary(self):
        # A smaller limit exercises the same boundary without a 60 MB allocation.
        with patch('src.backend.api.uploads.MAX_UPLOAD_BYTES', 4):
            exact = SimpleNamespace(read=AsyncMock(return_value=b'1234'))
            self.assertEqual(await read_upload(exact), b'1234')
            oversized = SimpleNamespace(read=AsyncMock(return_value=b'12345'))
            with self.assertRaisesRegex(ValueError, '60 MB upload limit'):
                await read_upload(oversized)
            oversized.read.assert_awaited_once_with(5)
