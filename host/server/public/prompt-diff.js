/** Line diff with a bounded work budget for large admin-edited prompts. */
export function promptDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4000000) {
    let start = 0, tail = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return [...a.slice(0, start).map(line => ({ kind: 'same', line })),
      ...a.slice(start, a.length - tail).map(line => ({ kind: 'remove', line })),
      ...b.slice(start, b.length - tail).map(line => ({ kind: 'add', line })),
      ...a.slice(a.length - tail).map(line => ({ kind: 'same', line }))];
  }
  const stride = b.length + 1, lengths = new Uint32Array((a.length + 1) * stride);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    lengths[i * stride + j] = a[i] === b[j] ? lengths[(i + 1) * stride + j + 1] + 1 : Math.max(lengths[(i + 1) * stride + j], lengths[i * stride + j + 1]);
  const result = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'same', line: a[i++] }); j++; }
    else if (i < a.length && (j === b.length || lengths[(i + 1) * stride + j] >= lengths[i * stride + j + 1])) result.push({ kind: 'remove', line: a[i++] });
    else result.push({ kind: 'add', line: b[j++] });
  }
  return result;
}
