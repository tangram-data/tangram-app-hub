#!/usr/bin/env python3

"""Build a byte-for-byte reproducible Tangram app tarball."""

from __future__ import annotations

import argparse
import copy
import gzip
import os
from pathlib import Path
import tarfile
from typing import Optional


def normalized_tar_info(info: tarfile.TarInfo) -> Optional[tarfile.TarInfo]:
    basename = Path(info.name).name
    if basename == ".DS_Store" or basename.startswith("._"):
        return None

    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    return info


def normalized_member_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return "."

    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe archive member: {name}")
    return f"./{path.as_posix()}"


def write_directory(archive: tarfile.TarFile, source: Path) -> None:
    paths = [source]
    paths.extend(
        sorted(
            (
                path
                for path in source.rglob("*")
                if not any(
                    part == ".DS_Store" or part.startswith("._")
                    for part in path.relative_to(source).parts
                )
            ),
            key=lambda path: path.relative_to(source).as_posix(),
        )
    )
    for path in paths:
        relative_path = path.relative_to(source)
        arcname = "." if relative_path == Path(".") else f"./{relative_path.as_posix()}"
        archive.add(
            path,
            arcname=arcname,
            recursive=False,
            filter=normalized_tar_info,
        )


def write_normalized_archive(
    archive: tarfile.TarFile, source_archive: Path
) -> None:
    with tarfile.open(source_archive, mode="r:*") as source:
        members = []
        seen_names = set()
        for original_member in source.getmembers():
            member = copy.copy(original_member)
            member.name = normalized_member_name(member.name)
            if member.name in seen_names:
                raise ValueError(f"duplicate archive member: {member.name}")
            seen_names.add(member.name)
            member = normalized_tar_info(member)
            if member is not None:
                members.append((member, original_member))

        for member, original_member in sorted(
            members, key=lambda item: item[0].name
        ):
            file_data = source.extractfile(original_member) if member.isfile() else None
            archive.addfile(member, file_data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--normalize-archive",
        action="store_true",
        help="normalize an existing tar archive instead of packaging a directory",
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = args.source.resolve(strict=True)
    output = args.output.resolve()
    if args.normalize_archive and not source.is_file():
        parser.error(f"source is not an archive file: {source}")
    if not args.normalize_archive and not source.is_dir():
        parser.error(f"source is not a directory: {source}")
    if not args.normalize_archive and (output == source or source in output.parents):
        parser.error("output must be outside the source directory")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f".{output.name}.tmp")
    with temporary_output.open("wb") as raw_output:
        with gzip.GzipFile(
            filename="", fileobj=raw_output, mode="wb", mtime=0
        ) as gzip_output:
            with tarfile.open(
                fileobj=gzip_output, mode="w", format=tarfile.PAX_FORMAT
            ) as archive:
                if args.normalize_archive:
                    write_normalized_archive(archive, source)
                else:
                    write_directory(archive, source)
    os.replace(temporary_output, output)


if __name__ == "__main__":
    main()
