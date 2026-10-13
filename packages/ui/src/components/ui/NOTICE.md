# Vendored coss ui components

The files in this directory are copied from coss ui (https://coss.com/ui). The shadcn CLI takes them from the
`@coss` registry (see `components.json`), which is built from `apps/ui/registry/default/` in
https://github.com/cosscom/ui. That directory is licensed under the MIT License, reproduced below; the rest of the
upstream repository is AGPL-3.0 and is not vendored here.

These changes are made after a copy:

- the `@/` import aliases the CLI writes become relative `.ts`/`.tsx` paths, so the package compiles with `tsc`
  under NodeNext;
- a variants helper, constant or type that a public signature names is exported, so API Extractor can report
  it from the package entry point;
- `button.tsx`: the `destructive` variant takes its fill, border, shadow and label from `destructive-button` and
  `destructive-button-foreground` (`theme.css`) in place of `destructive` and `text-white`, so the label meets
  WCAG AA 4.5 : 1 in both themes (doc 03 "Theme tokens").

## MIT License

Copyright (c) 2025 coss.com
Originally Copyright (c) 2025 Origin UI

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
