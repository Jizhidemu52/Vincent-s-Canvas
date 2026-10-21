#!/bin/sh
set -eu

component=${1:?Usage: build-from-source.sh minio-or-mc OUTPUT_DIRECTORY}
output=${2:?Missing output directory}
case "$component" in
  minio)
    # Official RELEASE.2025-04-22T22-12-26Z, matching the former container.
    commit=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e
    version=2025-04-22T22:12:26Z
    release=RELEASE.2025-04-22T22-12-26Z
    checksum=7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5
    ;;
  mc)
    # Official RELEASE.2025-04-16T18-13-26Z, shared by init and backup.
    commit=b00526b153a31b36767991a4f5ce2cced435ee8e
    version=2025-04-16T18:13:26Z
    release=RELEASE.2025-04-16T18-13-26Z
    checksum=4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae
    ;;
  *) echo "Unknown MinIO component: $component" >&2; exit 1 ;;
esac

mkdir -p "$output/licenses" "$output/source"
output=$(cd "$output" && pwd)
temp_root=$(cd "${TMPDIR:-/tmp}" && pwd)
work=$(mktemp -d "$temp_root/canvas-minio-build.XXXXXX")
cleanup() {
  case "$work" in
    "$temp_root"/canvas-minio-build.*) rm -rf -- "$work" ;;
    *) echo "Refusing unexpected build directory: $work" >&2 ;;
  esac
}
trap cleanup EXIT
archive="$output/source/$component-$commit.tar.gz"
curl --fail --location --retry 3 --retry-all-errors --show-error --silent \
  "https://codeload.github.com/minio/$component/tar.gz/$commit" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
tar -xzf "$archive" --strip-components=1 -C "$work"
cd "$work"

# Use the release's go.mod/go.sum; never resolve @latest or rewrite dependencies.
export CGO_ENABLED=0 GOTOOLCHAIN=local
sha256sum go.mod go.sum > "$work/dependencies.sha256"
go mod download
go mod verify
package="github.com/minio/$component/cmd"
short_commit=$(printf '%.12s' "$commit")
ldflags="-s -w -X $package.Version=$version -X $package.CopyrightYear=2025"
ldflags="$ldflags -X $package.ReleaseTag=$release -X $package.CommitID=$commit -X $package.ShortCommitID=$short_commit"
go build -mod=readonly -buildvcs=false -trimpath -tags kqueue -ldflags "$ldflags" -o "$output/$component" .
sha256sum -c "$work/dependencies.sha256"
cp LICENSE CREDITS "$output/licenses/"
"$output/$component" --version
