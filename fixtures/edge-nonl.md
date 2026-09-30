---
title: Edge cases
tags: [fixture, parser]
---

# Edge cases

A paragraph with `inline code`, **bold**, _emphasis_, a [link](https://example.com), and a trailing
soft break inside one paragraph.

## Code fences

```ts
// Looks like markdown but is code:
# not a heading
- not a list item
| not | a table |
```

~~~
tilde fence with ``` inside
~~~

    indented code block

## Nested lists

- first level
    - second level with `code`
        1. third level ordered
        2. another ordered item

           with a loose paragraph
    - back to second
- first level again

1. ordered
2. ordered with a nested fence:

   ```sh
   echo "inside a list"
   ```

- [ ] task item
- [x] done task

## Table

| Column A | Column `B` | Escaped \| pipe |
| :------- | :--------: | --------------: |
| one      | `two`      | three           |
| four     |            | six             |

## Blockquote

> A quote with a list:
>
> - item one
> - item two
>
> > nested quote

## HTML block

<div class="note">
  <p>Raw HTML block renders as text.</p>
</div>

<!-- an HTML comment -->

---

Final paragraph after a thematic break.[^1]

[^1]: A footnote definition.

[ref]: https://example.com "Reference definition"