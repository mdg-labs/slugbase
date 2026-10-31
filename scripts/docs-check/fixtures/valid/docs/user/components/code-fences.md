---
title: Code fences
description: Code may hold any text.
edition: ce
---

A fence is not parsed, so it may hold anything:

```js
import { thing } from "./thing.js";
export const value = {{ nested }};
<script>alert(1)</script>
```

So does `<script>` or `{inline}` code, and a ~~~ fence:

~~~html
<iframe src="https://example.com"></iframe>
<!-- comment -->
~~~

Markdown links and images: [the guide](../getting-started.md) and ![A shot](./shot.png).
