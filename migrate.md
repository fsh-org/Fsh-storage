Things change over time, here are some migration steps to mantain functionality.
Please do in order.

1. Add correct size to files without them (marked as "0")
2. Convert sizes to numbers ("123" -> 123)
3. Add chunk sizes
```js
Object.keys(files.all()).forEach(k=>{
  files.set(k, files.get(k).map(p=>{
    p.chunkSize = (p.channel?25:10)*1024*1024;
    return p;
  }));
});
```
4. Change chunk sizes to 25mb for files previous to Jan 30, 2025 and 10mb after (Mostly done by 3)