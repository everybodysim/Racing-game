import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const file = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const dataUrl = 'data:image/png;base64,' + readFileSync(file).toString('base64');
const rows = await page.evaluate(async (url) => {
	const img = new Image();
	await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
	const c = document.createElement('canvas');
	c.width = 96; c.height = 48;
	const g = c.getContext('2d');
	g.drawImage(img, 0, 0, 96, 48);
	const d = g.getImageData(0, 0, 96, 48).data;
	const chars = ' .:-=+*#%@';
	const out = [];
	for (let y = 0; y < 48; y++) {
		let line = '';
		for (let x = 0; x < 96; x++) {
			const i = (y * 96 + x) * 4;
			const L = (0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]) / 255;
			line += chars[Math.min(9, Math.floor(L * 10))];
		}
		out.push(line);
	}
	return out;
}, dataUrl);
console.log(rows.join('\n'));
await browser.close();
