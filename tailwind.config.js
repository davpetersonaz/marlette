// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
	content: [
		"./views/**/*.{ejs,html,js}",
		"./public/**/*.{ejs,html,js}"
	],
	theme: {
		extend: {
			colors: {
				navy: '#1D3557',
				'warm-white': '#F8F6F2',
				accent: '#B23A48'
			},
			fontFamily: {
				serif: ['Merriweather', 'serif'],
				sans: ['Inter', 'system-ui', 'sans-serif']
			}
		}
	},
	plugins: []
}