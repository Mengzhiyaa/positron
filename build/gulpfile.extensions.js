/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Increase max listeners for event emitters
require('events').EventEmitter.defaultMaxListeners = 100;

const gulp = require('gulp');
const path = require('path');
const nodeUtil = require('util');
const es = require('event-stream');
const filter = require('gulp-filter');
const util = require('./lib/util');
const { getVersion } = require('./lib/getVersion');
const task = require('./lib/task');
const watcher = require('./lib/watch');
const createReporter = require('./lib/reporter').createReporter;
const glob = require('glob');
const root = path.dirname(__dirname);
const commit = getVersion(root);
const plumber = require('gulp-plumber');
const ext = require('./lib/extensions');

const extensionsPath = path.join(path.dirname(__dirname), 'extensions');

// To save 250ms for each gulp startup, we are caching the result here
// const compilations = glob.sync('**/tsconfig.json', {
// 	cwd: extensionsPath,
// 	ignore: ['**/out/**', '**/node_modules/**']
// });
const compilations = [
	// --- Start Positron ---
	'positron-data-viewer/tsconfig.json',
	'positron-data-viewer/ui/tsconfig.json',
	'positron-javascript/tsconfig.json',
	'positron-notebook-controllers/tsconfig.json',
	'positron-r/tsconfig.json',
	'positron-python/tsconfig.json',
	'positron-proxy/tsconfig.json',
	'positron-zed/tsconfig.json',
	// --- End Positron ---
	'authentication-proxy/tsconfig.json',
	'configuration-editing/build/tsconfig.json',
	'configuration-editing/tsconfig.json',
	'css-language-features/client/tsconfig.json',
	'css-language-features/server/tsconfig.json',
	'debug-auto-launch/tsconfig.json',
	'debug-server-ready/tsconfig.json',
	'emmet/tsconfig.json',
	'extension-editing/tsconfig.json',
	'git/tsconfig.json',
	'git-base/tsconfig.json',
	'github-authentication/tsconfig.json',
	'github/tsconfig.json',
	'grunt/tsconfig.json',
	'gulp/tsconfig.json',
	'html-language-features/client/tsconfig.json',
	'html-language-features/server/tsconfig.json',
	'ipynb/tsconfig.json',
	'jake/tsconfig.json',
	'json-language-features/client/tsconfig.json',
	'json-language-features/server/tsconfig.json',
	// --- Start Positron ---
	'jupyter-adapter/tsconfig.json',
	// --- End Positron ---
	'markdown-language-features/preview-src/tsconfig.json',
	'markdown-language-features/server/tsconfig.json',
	'markdown-language-features/tsconfig.json',
	'markdown-math/tsconfig.json',
	'media-preview/tsconfig.json',
	'merge-conflict/tsconfig.json',
	'microsoft-authentication/tsconfig.json',
	'notebook-renderers/tsconfig.json',
	'npm/tsconfig.json',
	'php-language-features/tsconfig.json',
	'search-result/tsconfig.json',
	'references-view/tsconfig.json',
	'simple-browser/tsconfig.json',
	'tunnel-forwarding/tsconfig.json',
	'typescript-language-features/test-workspace/tsconfig.json',
	'typescript-language-features/web/tsconfig.json',
	'typescript-language-features/tsconfig.json',
	'vscode-api-tests/tsconfig.json',
	'vscode-colorize-tests/tsconfig.json',
	'vscode-test-resolver/tsconfig.json'
];

const getBaseUrl = out => `https://ticino.blob.core.windows.net/sourcemaps/${commit}/${out}`;

const tasks = compilations.map(function (tsconfigFile) {
	const absolutePath = path.join(extensionsPath, tsconfigFile);
	const relativeDirname = path.dirname(tsconfigFile);

	const overrideOptions = {};
	overrideOptions.sourceMap = true;

	const name = relativeDirname.replace(/\//g, '-');

	const root = path.join('extensions', relativeDirname);
	const srcBase = path.join(root, 'src');
	const src = path.join(srcBase, '**');
	const srcOpts = { cwd: path.dirname(__dirname), base: srcBase };

	const out = path.join(root, 'out');
	const baseUrl = getBaseUrl(out);

	let headerId, headerOut;
	const index = relativeDirname.indexOf('/');
	if (index < 0) {
		headerId = 'vscode.' + relativeDirname;
		headerOut = 'out';
	} else {
		headerId = 'vscode.' + relativeDirname.substr(0, index);
		headerOut = relativeDirname.substr(index + 1) + '/out';
	}

	function createPipeline(build, emitError, transpileOnly) {
		const nlsDev = require('vscode-nls-dev');
		const tsb = require('./lib/tsb');
		const sourcemaps = require('gulp-sourcemaps');

		const reporter = createReporter('extensions');

		overrideOptions.inlineSources = Boolean(build);
		overrideOptions.base = path.dirname(absolutePath);

		const compilation = tsb.create(absolutePath, overrideOptions, { verbose: false, transpileOnly, transpileOnlyIncludesDts: transpileOnly, transpileWithSwc: true }, err => reporter(err.toString()));

		const pipeline = function () {
			const input = es.through();
			// --- Start Positron ---
			// Add '**/*.tsx'.
			const tsFilter = filter(['**/*.ts', '**/*.tsx', '!**/lib/lib*.d.ts', '!**/node_modules/**'], { restore: true });
			// --- Start Positron ---
			const output = input
				.pipe(plumber({
					errorHandler: function (err) {
						if (err && !err.__reporter__) {
							reporter(err);
						}
					}
				}))
				.pipe(tsFilter)
				.pipe(util.loadSourcemaps())
				.pipe(compilation())
				.pipe(build ? nlsDev.rewriteLocalizeCalls() : es.through())
				.pipe(build ? util.stripSourceMappingURL() : es.through())
				.pipe(build ? es.through() : util.stripImportStatements())
				.pipe(sourcemaps.write('.', {
					sourceMappingURL: !build ? null : f => `${baseUrl}/${f.relative}.map`,
					addComment: !!build,
					includeContent: !!build,
					sourceRoot: '../src'
				}))
				.pipe(tsFilter.restore)
				.pipe(build ? nlsDev.bundleMetaDataFiles(headerId, headerOut) : es.through())
				// Filter out *.nls.json file. We needed them only to bundle meta data file.
				.pipe(filter(['**', '!**/*.nls.json']))
				.pipe(reporter.end(emitError));

			return es.duplex(input, output);
		};

		// add src-stream for project files
		pipeline.tsProjectSrc = () => {
			return compilation.src(srcOpts);
		};
		return pipeline;
	}

	const cleanTask = task.define(`clean-extension-${name}`, util.rimraf(out));

	const transpileTask = task.define(`transpile-extension:${name}`, task.series(cleanTask, () => {
		const pipeline = createPipeline(false, true, true);
		// --- Start Positron ---
		// Add '!**/*.tsx'.
		const nonts = gulp.src(src, srcOpts).pipe(filter(['**', '!**/*.ts', '!**/*.tsx']));
		// --- End Positron ---
		const input = es.merge(nonts, pipeline.tsProjectSrc());

		return input
			.pipe(pipeline())
			.pipe(gulp.dest(out));
	}));

	const compileTask = task.define(`compile-extension:${name}`, task.series(cleanTask, () => {
		const pipeline = createPipeline(false, true);
		// --- Start Positron ---
		// Add '!**/*.tsx'.
		const nonts = gulp.src(src, srcOpts).pipe(filter(['**', '!**/*.ts', '!**/*.tsx']));
		// --- End Positron ---
		const input = es.merge(nonts, pipeline.tsProjectSrc());

		return input
			.pipe(pipeline())
			.pipe(gulp.dest(out));
	}));

	const watchTask = task.define(`watch-extension:${name}`, task.series(cleanTask, () => {
		const pipeline = createPipeline(false);
		// --- Start Positron ---
		// Add '!**/*.tsx'.
		const nonts = gulp.src(src, srcOpts).pipe(filter(['**', '!**/*.ts', '!**/*.tsx']));
		// --- End Positron ---
		const input = es.merge(nonts, pipeline.tsProjectSrc());
		const watchInput = watcher(src, { ...srcOpts, ...{ readDelay: 200 } });

		return watchInput
			.pipe(util.incremental(pipeline, input))
			.pipe(gulp.dest(out));
	}));

	const compileBuildTask = task.define(`compile-build-extension-${name}`, task.series(cleanTask, () => {
		const pipeline = createPipeline(true, true);
		// --- Start Positron ---
		// Add '!**/*.tsx'.
		const nonts = gulp.src(src, srcOpts).pipe(filter(['**', '!**/*.ts', '!**/*.tsx']));
		// --- End Positron ---
		const input = es.merge(nonts, pipeline.tsProjectSrc());

		return input
			.pipe(pipeline())
			.pipe(gulp.dest(out));
	}));

	// Tasks
	gulp.task(transpileTask);
	gulp.task(compileTask);
	gulp.task(watchTask);

	return { transpileTask, compileTask, watchTask, compileBuildTask };
});

const transpileExtensionsTask = task.define('transpile-extensions', task.parallel(...tasks.map(t => t.transpileTask)));
gulp.task(transpileExtensionsTask);

const compileExtensionsTask = task.define('compile-extensions', task.parallel(...tasks.map(t => t.compileTask)));
gulp.task(compileExtensionsTask);
exports.compileExtensionsTask = compileExtensionsTask;

const watchExtensionsTask = task.define('watch-extensions', task.parallel(...tasks.map(t => t.watchTask)));
gulp.task(watchExtensionsTask);
exports.watchExtensionsTask = watchExtensionsTask;

const compileExtensionsBuildLegacyTask = task.define('compile-extensions-build-legacy', task.parallel(...tasks.map(t => t.compileBuildTask)));
gulp.task(compileExtensionsBuildLegacyTask);

//#region Extension media

const compileExtensionMediaTask = task.define('compile-extension-media', () => ext.buildExtensionMedia(false));
gulp.task(compileExtensionMediaTask);
exports.compileExtensionMediaTask = compileExtensionMediaTask;

const watchExtensionMedia = task.define('watch-extension-media', () => ext.buildExtensionMedia(true));
gulp.task(watchExtensionMedia);
exports.watchExtensionMedia = watchExtensionMedia;

const compileExtensionMediaBuildTask = task.define('compile-extension-media-build', () => ext.buildExtensionMedia(false, '.build/extensions'));
gulp.task(compileExtensionMediaBuildTask);
exports.compileExtensionMediaBuildTask = compileExtensionMediaBuildTask;

//#endregion

// --- Start Positron ---

const copyExtensionBinariesTask = task.define('copy-extension-binaries', () => { ext.copyExtensionBinaries('.build/extensions'); });
gulp.task(copyExtensionBinariesTask);
exports.copyExtensionBinariesTask = copyExtensionBinariesTask;

// --- End Positron ---

//#region Azure Pipelines

const cleanExtensionsBuildTask = task.define('clean-extensions-build', util.rimraf('.build/extensions'));
const compileExtensionsBuildTask = task.define('compile-extensions-build', task.series(
	cleanExtensionsBuildTask,
	task.define('bundle-marketplace-extensions-build', () => ext.packageMarketplaceExtensionsStream(false).pipe(gulp.dest('.build'))),
	task.define('bundle-extensions-build', () => ext.packageLocalExtensionsStream(false, false).pipe(gulp.dest('.build'))),
	// --- Start Positron ---
	copyExtensionBinariesTask
	// --- End Positron ---
));

gulp.task(compileExtensionsBuildTask);
gulp.task(task.define('extensions-ci', task.series(compileExtensionsBuildTask, compileExtensionMediaBuildTask)));

const compileExtensionsBuildPullRequestTask = task.define('compile-extensions-build-pr', task.series(
	cleanExtensionsBuildTask,
	task.define('bundle-marketplace-extensions-build', () => ext.packageMarketplaceExtensionsStream(false).pipe(gulp.dest('.build'))),
	task.define('bundle-extensions-build-pr', () => ext.packageLocalExtensionsStream(false, true).pipe(gulp.dest('.build'))),
));

gulp.task(compileExtensionsBuildPullRequestTask);
gulp.task(task.define('extensions-ci-pr', task.series(compileExtensionsBuildPullRequestTask, compileExtensionMediaBuildTask)));


exports.compileExtensionsBuildTask = compileExtensionsBuildTask;

//#endregion

const compileWebExtensionsTask = task.define('compile-web', () => buildWebExtensions(false));
gulp.task(compileWebExtensionsTask);
exports.compileWebExtensionsTask = compileWebExtensionsTask;

const watchWebExtensionsTask = task.define('watch-web', () => buildWebExtensions(true));
gulp.task(watchWebExtensionsTask);
exports.watchWebExtensionsTask = watchWebExtensionsTask;

/**
 * @param {boolean} isWatch
 */
async function buildWebExtensions(isWatch) {
	const webpackConfigLocations = await nodeUtil.promisify(glob)(
		path.join(extensionsPath, '**', 'extension-browser.webpack.config.js'),
		{ ignore: ['**/node_modules'] }
	);
	return ext.webpackExtensions('packaging web extension', isWatch, webpackConfigLocations.map(configPath => ({ configPath })));
}
