# Breached-password range dataset

`breached-sha1.bin` is the dataset behind the breached-password check of the password policy (doc 02
section 2.5, Q15). It is read from disk by the process itself; checking a password makes no network
request.

## Format

A sequence of 20-byte records, no header: the SHA-1 digest of a password's UTF-8 bytes, sorted in
ascending byte order and without duplicates. A lookup hashes the password, takes the first 5 hexadecimal
characters of the digest (the range prefix, as in the k-anonymity range API of the Pwned Passwords
service) and compares the remaining 35 against the records of that range. SHA-1 is only the index that
format uses; it protects nothing, and no password is stored in the file.

## Source and subset rule

- Source: `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` of the SecLists
  repository (<https://github.com/danielmiessler/SecLists>), revision
  `997dd861b9fa2623f06f30d5f9085713ce830f0c`, SHA-256
  `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51`. It lists the most common
  passwords from a public collection of passwords published after breaches, most common first.
- Subset: the first 1,000,000 rows, keeping the passwords of 12 to 256 characters (the lengths the policy
  accepts; a shorter one is refused on length before the dataset is consulted).
- Result: 46,296 records, 925,920 bytes, SHA-256
  `e8d13ff1fb8365aa916a8110b6b384cd4074590c84341b8f2ac2ac93f6acf1b9`.

## Licence

SecLists is licensed under the MIT licence, which this notice reproduces. The dataset holds one-way
digests derived from the source list and none of its text.

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Regenerating it for a release

1. Download the source file at the revision above, or at a newer revision, into a directory outside the
   repository.
2. For a newer revision, update the revision and `SOURCE_SHA256` in `scripts/generate-breached-passwords.mjs`
   and the figures above in the same change.
3. Run `node scripts/generate-breached-passwords.mjs <downloaded file>`. The script refuses a file whose
   SHA-256 differs from the pinned one and prints the record count, size and SHA-256 of the result.
4. Commit the new `breached-sha1.bin` and this notice together.
