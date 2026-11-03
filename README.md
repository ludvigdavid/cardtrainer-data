# cardtrainer.io card feed

Builds a small JSON file per Pokémon TCG set (cards, picture links, euro prices) every night and
publishes it with GitHub Pages. The cardtrainer.io app reads it from
`https://ludvigdavid.github.io/cardtrainer-data/`.

- Card data: [TCGdex cards-database](https://github.com/tcgdex/cards-database) (MIT licence)
- Card pictures: hosted by TCGdex (assets.tcgdex.net)
- Prices: Cardmarket's public price guide (EUR)

`sets.json` lists the app's sets; it's updated by `npm run feed` in the app project.
Run the workflow by hand from the Actions tab ("Update card feed" → Run workflow).
