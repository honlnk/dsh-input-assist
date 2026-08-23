import { defineConfig } from 'tsdown'

// client 半边必须包成 dsh ModuleLoader 的 lazy-CJS factory 格式（host 原样
// serve 本产物，运行时零编译），banner/footer 提供 module/exports shim。
const CLIENT_BANNER =
	'window.__ModuleLoader__.load({id:"dsh-input-assist",factory:(require)=>{var module={exports:{}};var exports=module.exports;'
const CLIENT_FOOTER = 'return module.exports;}});'

export default defineConfig([
	{
		// host 半边：ESM + 类型声明，cordis loader 直接 import lib/index.js
		entry: { index: 'src/index.ts' },
		outDir: 'lib',
		format: 'esm',
		dts: true,
		sourcemap: true,
		target: 'node20',
		external: [/^@deepseek-ai\//, 'react'],
		minify: false,
		outputOptions: { entryFileNames: '[name].js' },
	},
	{
		// 浏览器半边：CJS + ModuleLoader 壳；react / dsh-client-runtime 由宿主
		// 种子模块提供（external），本地模块（词典等）打包进 bundle
		entry: { client: 'src/client.ts' },
		outDir: 'lib',
		format: 'cjs',
		dts: false,
		sourcemap: true,
		target: 'chrome110',
		external: ['react', '@deepseek-ai/dsh-client-runtime/client'],
		minify: false,
		outputOptions: {
			entryFileNames: '[name].js',
			banner: CLIENT_BANNER,
			footer: CLIENT_FOOTER,
		},
	},
])
