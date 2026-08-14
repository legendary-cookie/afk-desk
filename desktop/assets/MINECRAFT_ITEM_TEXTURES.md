# Minecraft item texture atlas

`minecraft-items.png` is a compact atlas generated from the Minecraft 1.21.8 textures indexed by `minecraft-assets` 1.17.0. `minecraft-items.js` maps Minecraft item names to atlas cells.

Regenerate it with:

```powershell
python scripts/build-item-atlas.py <minecraft-assets-data-version-directory> assets
```

Minecraft textures are copyright Mojang Studios. AFK Desk is not affiliated with Mojang or Microsoft.
