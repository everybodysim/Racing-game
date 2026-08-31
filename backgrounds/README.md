# Loading Screen Backgrounds

The loading screen shown while the game boots picks a **random background** from this folder every time the page loads — 5 options, currently placeholders.

## How it works

Right inside `#loading-screen` in `index.html`, a small inline script runs immediately on page load:

```html
<script>
	(function() {
		var count = 5;
		var pick = Math.floor( Math.random() * count ) + 1;
		var screen = document.getElementById( 'loading-screen' );
		if ( screen ) screen.style.backgroundImage = "url('backgrounds/loading-bg-" + pick + ".jpg')";
	})();
</script>
```

It picks a number 1–5 and sets the background to `backgrounds/loading-bg-<N>.jpg`. A dark overlay (`rgba(6,10,16,0.68)`) sits on top via `#loading-screen::before` so the loading text/logo stay readable no matter which image shows.

## Replacing the placeholders

1. Drop your own image in as `loading-bg-1.jpg` through `loading-bg-5.jpg` (same filenames — just overwrite them)
2. Recommended: **JPG**, 1920×1080 or larger, optimized for web (aim under 150–200KB each so loading stays fast)
3. Images are `background-size: cover`, so any aspect ratio works, but wide/landscape shots look best

### Want more or fewer than 5?

Add/remove files named `loading-bg-6.jpg`, etc., and bump the `count` variable in the inline script in `index.html` to match.

## Current placeholders

Programmatically generated gradient placeholders — swap these for real cinematic racing shots whenever you're ready:

| File | Mood |
|------|------|
| `loading-bg-1.jpg` | Blue dusk with speed streaks |
| `loading-bg-2.jpg` | Sunset purple/orange |
| `loading-bg-3.jpg` | Night teal/green circuit |
| `loading-bg-4.jpg` | Red desert dusk |
| `loading-bg-5.jpg` | Midnight purple |

## Tips for great loading backgrounds

- **Dark images work best** — the overlay darkens by ~68%, so bright images can get muddy
- **High contrast** — headlights, neon track edges, or a silhouette against a bright sky read well
- **Motion blur** — conveys speed and matches the racing theme
- **No text** — the card already has the logo + status text; background text competes and looks messy
- **Cinematic angle** — low-angle shots of a car mid-corner or mid-drift look dramatic
