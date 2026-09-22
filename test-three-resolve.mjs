// Node loader hook: maps bare specifier 'three' to a minimal stub so that
// THREE-dependent browser modules (SkidMarks.js) can be unit-tested without
// a package.json / node_modules. Registered from test-skid-marks.mjs via
// `register()` from node:module.
export async function resolve( specifier, context, next ) {

	if ( specifier === 'three' ) {

		return {
			url: new URL( './test-three-stub.mjs', import.meta.url ).href,
			shortCircuit: true,
		};

	}
	return next( specifier, context );

}
