const fs = require('fs');
const assert = require('assert');

const py = JSON.parse(fs.readFileSync('py.json'));
const js = JSON.parse(fs.readFileSync('js.json'));

console.log(Object.keys(py));
console.log(Object.keys(js));

// check data format
assert.equal(py.firstSample, js.firstSample);
assert.equal(py.samples, js.samples);

// test pre-emphasis calculations
for (let i=0; i<py.preemph.length; i++) {
	const relativeError = Math.abs(py.preemph[i] - js.preemph[i]) / js.preemph[i];
	assert(!isNaN(relativeError) && relativeError <= 1e-6,
		'Preemphasis calculation failed. i=' + i + ' py=>' + py.preemph[i] + ' js=>' + js.preemph[i]);
}

// test signal division into frames
assert(py.nwin === js.nWin, "Not the same amount of windows. py=" + py.nwin + " js=" + js.nWin);

for (let i=0; i<py.frames.length; i++) {
	assert(py.frames[i].length === js.frames[i].length,
		'Not the same length of signal frames. i=' + i + ' py=>' + py.frames[i].length + ' js=>' + js.frames[i].length);

	for (let j=0; j<py.frames[i].length; j++) {
		const relativeError = Math.abs(py.frames[i][j] - js.frames[i][j]) / js.frames[i][j];
		assert(!isNaN(relativeError) && relativeError <= 1e-6,
			'Signal framing failed. i=' + i + ' j=' + j + ' relativeErr=' + relativeError);
	}
}

// test filter bank
console.log(py.energy);
console.log(py.energy.length);
console.log(js.energy);
assert.equal(py.energy, js.energy);
assert.equal(py.feat, js.feat);


// TODO

// end result test
assert.deepEqual(py.ceps, js.ceps);

/*'energy',
  'feat''*/
console.log('All tests are successful :)');