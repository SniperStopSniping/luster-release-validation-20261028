#!/usr/bin/env bash
# PREPARED ONLY: root must separately review/publish/dispatch. No network calls.
# Arguments: absolute driver directory (six old shards+manifest+delta), fresh subject path.
set -euo pipefail
export LC_ALL=C
new=1e3f8ab740aaf134e3a33af31b260c3c3a53080f
old=a745b0c80263a0bc129a8f50a58671d1c596f9ee
tree=3012f16a75d3a936e55c184b90a1b268b4dcc193
driver="$(cd "$1" && pwd -P)"
parent="$(cd "$(dirname "$2")" && pwd -P)"
subject="$parent/$(basename "$2")"
test ! -e "$subject"
test "$(df -Pk "$parent" | awk 'NR==2 {print $4}')" -ge 3145728
scratch="$(mktemp -d "$parent/.combined-source-reconstruction.XXXXXX")"
# This sibling scratch is NEVER inside the subject/install mount.
cleanup() { rm -rf -- "$scratch"; }
trap cleanup EXIT
safe_git() {
  env -i PATH=/usr/bin:/bin HOME="$scratch/empty-home" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_OPTIONAL_LOCKS=0 \
    /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.pager=cat -c credential.helper= -c diff.external= \
    -c pack.threads=1 -c pack.windowMemory=8m -c core.packedGitLimit=64m -c core.packedGitWindowSize=16m "$@"
}
printf '%s  %s\n' 44340862514418774246d6d283268d23afedf95f93493b17bb2aef8350253843 "$driver/snapshot-shards.sha256" | sha256sum --check
(cd "$driver"; sha256sum --check snapshot-shards.sha256)
# Verify concatenated old pack in a bounded stream; do not duplicate198MB on disk.
python3 - "$driver" <<'VERIFY_OLD'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]);digest=hashlib.sha256();size=0
for index in range(6):
    with (root/f'candidate-a745.pack.part{index:02d}').open('rb') as stream:
        for block in iter(lambda:stream.read(1048576),b''):
            digest.update(block);size+=len(block)
assert size==197937771
assert digest.hexdigest()=='e7ee5fd5b2d4084ca416d1025a2d9371e39e58d3216b17a5f67254ff9955a144'
VERIFY_OLD
printf '%s  %s\n' 235e4888ebe8f3652477bf615a89d437535f068f4cda8cd55458125569a925ba "$driver/candidate-a745-to-1e3f.delta.pack" | sha256sum --check
test "$(stat -c %s "$driver/candidate-a745-to-1e3f.delta.pack")" = 11846
safe_git init --bare --template= "$scratch/old.git"
printf '%s\n' "$old" > "$scratch/old.git/shallow"
cat "$driver"/candidate-a745.pack.part0{0,1,2,3,4,5} | safe_git -C "$scratch/old.git" index-pack --threads=1 --stdin --max-input-size=200000000
safe_git -C "$scratch/old.git" index-pack --threads=1 --stdin --max-input-size=20000 < "$driver/candidate-a745-to-1e3f.delta.pack"
printf '%s\n' "$new" > "$scratch/old.git/shallow"
test "$(safe_git -C "$scratch/old.git" rev-parse "$new^{tree}")" = "$tree"
# Explicit object closure: traverse ONLY the tree, then add ONLY the new commit.
# Do not pack refs/all/revisions/parent history from this6280-object scratch.
{
  printf '%s\n' "$new"
  safe_git -C "$scratch/old.git" rev-list --objects "$tree" | cut -d' ' -f1
} | sort -u > "$scratch/closure.oids"
test "$(wc -l < "$scratch/closure.oids")" = 6276
printf '%s  %s\n' f251649a0c3c77bf7682f55bab71d0bb467d0f391c28fbee5f779d2279bfb0c7 "$scratch/closure.oids" | sha256sum --check
# No thin/external deltas: create a self-contained reachable closure pack once.
safe_git -C "$scratch/old.git" pack-objects --stdout --threads=1 --window=0 --depth=0 --compression=6 < "$scratch/closure.oids" > "$scratch/combined.pack"
test "$(stat -c %s "$scratch/combined.pack")" -le 210000000
rm -rf -- "$scratch/old.git"
# Fresh repository, never the old scratch repository. Index existing pack IN PLACE
# and move it on this filesystem, avoiding a second full combined-pack copy.
safe_git init --template= "$subject"
printf '%s\n' "$new" > "$subject/.git/shallow"
packid="$(safe_git -C "$subject" index-pack --threads=1 --index-version=2 "$scratch/combined.pack")"
[[ "$packid" =~ ^[a-f0-9]{40}$ ]]
test "$(stat -c %d "$scratch")" = "$(stat -c %d "$subject/.git/objects/pack")"
mv -- "$scratch/combined.pack" "$subject/.git/objects/pack/pack-$packid.pack"
mv -- "$scratch/combined.idx" "$subject/.git/objects/pack/pack-$packid.idx"
safe_git -C "$subject" update-ref --no-deref HEAD "$new"
safe_git -C "$subject" fsck --strict --full --no-reflogs
safe_git -C "$subject" cat-file --batch-all-objects --batch-check='%(objectname)' | sort > "$scratch/actual.oids"
cmp "$scratch/closure.oids" "$scratch/actual.oids"
safe_git -C "$subject" cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' > "$scratch/types.txt"
test "$(awk '$2=="commit" {print $1}' "$scratch/types.txt")" = "$new"
test "$(awk '$2=="tree" {n++} END {print n+0}' "$scratch/types.txt")" = 885
test "$(awk '$2=="blob" {n++} END {print n+0}' "$scratch/types.txt")" = 5390
test "$(wc -l < "$scratch/types.txt")" = 6276
test "$(safe_git -C "$subject" rev-list --count HEAD)" = 1
test "$(safe_git -C "$subject" rev-parse HEAD^{tree})" = "$tree"
test "$(cat "$subject/.git/shallow")" = "$new"
for removed in a745b0c80263a0bc129a8f50a58671d1c596f9ee 649e328be9b2c094b09e14720a947d2c5721239c 14a325cd2cba6f982c52fc26ed72801650bc1e63 ff89b694c8729f8b88fc4080a8efa36a3ae481ae; do
  if safe_git -C "$subject" cat-file -e "$removed" 2>/dev/null; then exit 1; fi
done
safe_git -C "$subject" -c submodule.recurse=false checkout --force --detach "$new"
test -z "$(safe_git -C "$subject" status --porcelain)"
printf '%s  %s\n' 856f993caec05c85ba6c1dde46303efca1e14a7e4181396f6a60e3bee6156b78 "$subject/scripts/run-topup-cursor-postgres.mjs" | sha256sum --check
printf 'COMBINED_SUBJECT=%s OBJECTS=6276 COMMITS=1 TREES=885 BLOBS=5390 ANCESTOR_OBJECTS_RETAINED=0\n' "$new"
