"""Read uploaded files and reject any file larger than 60 MB."""

MAX_UPLOAD_BYTES = 60 * 1024 * 1024


async def read_upload(file):
    """Return the uploaded bytes, or raise ValueError for a missing or large file.

    Read one extra byte to detect files over the limit. This limit applies to
    each uploaded file; book and dictionary services check unzipped sizes.
    """
    if file is None or not hasattr(file, "read"):
        raise ValueError("Choose a file to import.")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("File exceeds the 60 MB upload limit.")
    return data
