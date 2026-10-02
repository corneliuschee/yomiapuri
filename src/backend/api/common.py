"""Bound multipart upload reads before handing data to domain services."""

MAX_UPLOAD = 60 * 1024 * 1024


async def uploaded(file):
    """Read at most 60 MB plus one sentinel byte; reject missing/oversized files.

    Return bytes for worker-thread parsing. This bounds an individual upload,
    not a decompressed archive or the combined size of a multi-file request.
    """
    if file is None or not hasattr(file, "read"):
        raise ValueError("Choose a file to import.")
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise ValueError("File exceeds the 60 MB upload limit.")
    return data
