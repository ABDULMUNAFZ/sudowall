# Landing page

`index.html` is the whole site: static, no build step, no cookies, no third-party requests.

It is deployed to Vercel as the `tortoise-gate` project at https://tortoise-gate.vercel.app. To publish a change, from this folder:

```sh
vercel deploy --prod
```

GitHub Pages is not used: the owner account's Pages custom domain points at another site, so project pages would redirect there.

To show the demo video, set `VIDEO_URL` in the script at the bottom of `index.html` to a `https://www.youtube-nocookie.com/embed/...` URL. Until then the video section stays hidden.
