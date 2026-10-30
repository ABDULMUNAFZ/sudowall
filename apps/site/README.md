# Landing page

`index.html` is the whole site: static, no build step, no cookies, no third-party requests.

It is deployed to Vercel as the `sudowall` project at https://www.sudowall.tech. The project is connected to this repository with its root directory set to `apps/site` and no build step, so every push to `main` that changes this folder deploys it; pushes that do not touch it are skipped (`git diff --quiet HEAD^ HEAD -- .`). A manual deploy from this folder also works:

```sh
vercel deploy --prod
```

GitHub Pages is not used: the owner account's Pages custom domain points at another site, so project pages would redirect there.

To show the demo video, set `VIDEO_URL` in the script at the bottom of `index.html` to a `https://www.youtube-nocookie.com/embed/...` URL. Until then the video section stays hidden.
