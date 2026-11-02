import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/'] },
	js.configs.recommended,
	{
		files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'deploy/**/*.js', 'eslint.config.js'],
		languageOptions: { globals: globals.node }
	},
	{
		files: ['static/**/*.js'],
		languageOptions: { globals: globals.browser }
	}
];
