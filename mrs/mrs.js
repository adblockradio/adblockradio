// Maximal repeated sequences computation
// inspired by
// Jiansong Chen, Teng Li, Lei Zhu, Peng Ding, Bo Xu,
// "Commercial detection by mining maximal repeated sequence in audio stream", , vol. 00, no. , pp. 1-4, 2011,
// doi:10.1109/ICME.2011.6012115
// paper available at https://www.computer.org/csdl/proceedings/icme/2011/4348/00/06012115.pdf

// copyright Alexandre Storelli

var log = require("loglevel");
log.setLevel("debug");
var cp = require("child_process");
var async = require("async");
var fs = require("fs");
var dsp = require("dsp.js");

const SAMPLING = 4096; // samples per second

var getMrs = function(files1, files2, callback) {

	decodeAudio(files1, function(err, buf1) {
		if (err) log.warn("getCommonAudio: decoding error err=" + err + " filelist=" + JSON.stringify(files1));
		decodeAudio(files2, function(err, buf2) {
			if (err) log.warn("getCommonAudio: decoding error err=" + err + " filelist=" + JSON.stringify(files2));
			log.debug("getCommonAudio: audio decoded. N1=" + buf1.length/2 + " N2=" + buf2.length/2);
			var alignData = alignAudio(buf1, buf2);
			var bounds = getBoundsCommonAudio(buf1, buf2, alignData);
			sliceAudio(files1, bounds.buf1.begin, bounds.buf1.end, "mrs1.mp3", function() {});
			sliceAudio(files2, bounds.buf2.begin, bounds.buf2.end, "mrs2.mp3", function() {});
		});
	});

}

var decodeAudio = function(fileList, callback) {
	// decode audio files to single channel PCM, 16-bit
	var buffer = Buffer.alloc(0);
	var decoder = require('child_process').spawn('ffmpeg', [
		'-i', 'pipe:0',
		'-acodec', 'pcm_s16le',
		'-ar', SAMPLING,
		'-ac', 1,
		'-f', 'wav',
		'-v', 'fatal',
		'pipe:1'
	], { stdio: ['pipe', 'pipe', process.stderr] });

	async.forEach(fileList, function(file, next) {
		var fread = fs.createReadStream(file);
		fread.pipe(decoder.stdin);
		fread.on("end", function() {
			fread.unpipe(decoder.stdin);
			next();
		});
		fread.on("error", function(err) {
			log.warn("decodeAudio: file=" + file + " err=" + err);
			callback(err, null);
		});
	}, function(err) {
		//log.debug("decodeAudio: all audio data submitted for decoding");
		decoder.stdin.end();
		decoder.stdout.on("data", function(buf) {
			buffer = Buffer.concat([buffer, buf]);
		});
		decoder.stdout.on("end", function() {
			//log.debug("decodeAudio: all audio data decoded (stdout end)");
			callback(null, buffer);
		});
	});
}

var sliceAudio = function(fileList, tbeg, tend, targetFile, callback) {
	log.debug("sliceAudio: tbeg=" + tbeg + " tend=" + tend + " targetFile=" + targetFile);
	var slicer = require('child_process').spawn('ffmpeg', [
		'-i', 'pipe:0',
		'-ss', tbeg,
		'-to', tend,
		'-acodec', 'copy',
		'-format', 'mp3',
		'-y',
		//'-v', 'fatal',
		//'pipe:1'
		targetFile
	], { stdio: ['pipe', 'pipe', process.stderr] });
	
	async.forEach(fileList, function(file, next) {
		var fread = fs.createReadStream(file);
		fread.pipe(slicer.stdin);
		fread.on("end", function() {
			fread.unpipe(slicer.stdin);
			next();
		});
		fread.on("error", function(err) {
			log.warn("decodeAudio: file=" + file + " err=" + err);
			callback(err);
		});
	}, function(err) {
		//log.debug("decodeAudio: all audio data submitted for decoding");
		slicer.stdin.end();
		slicer.stdout.on("end", function() {
			//log.debug("decodeAudio: all audio data decoded (stdout end)");
			callback(null);
		});
	});
}

var alignAudio = function(buf1, buf2) {
	// find the correct alignment in time so that the cross-correlation between
	// buf1 and buf2 is at its maximum.

	var l = buf1.length;
	var l1 = Math.pow(2, Math.ceil(Math.log2(l)));
	if (l1 > l) {
		log.debug("alignAudio: pad the buffers of len " + l + " with " + (l1-l) + " zeros");
	}
	var bufzeros = Buffer.alloc(l1-l);
	var xc = xcorrFFT(Buffer.concat([buf1, bufzeros]), Buffer.concat([buf2, bufzeros]));
	log.debug("alignAudio: xcorr=" + xc.max + " at tmax=" + xc.tmax);

	var lag; // always positive
	var commonAudioFirstInBuf1; // ugly variable name, but at least we know what's happening
	if (xc.tmax < l1/4) { // common audio happens earlier in buf2 than in buf1
		lag = xc.tmax;
		commonAudioFirstInBuf1 = false;
		log.debug("alignAudio: common audio happens earlier in buf2 than in buf1. lag=" + Math.round(lag / SAMPLING*10)/10 + "s");
	} else { // common audio happens earlier in buf1 than in buf2
		lag = l1/2 - xc.tmax;
		commonAudioFirstInBuf1 = true;
		log.debug("alignAudio: common audio happens earlier in buf1 than in buf2. lag=" + Math.round(lag / SAMPLING*10)/10 + "s")
	}

	// test that the lag is correct. xcBis.tmax should be zero
	//   and xcBis.max should be higher than xc.max
	//   (because the segment is more focused on common data)
	/*var room = l - 2*lag;
	if (commonAudioFirstInBuf1) {
		l1 = Math.pow(2, Math.ceil(Math.log2(room)));
		var buf1bis = Buffer.concat([buf1.slice(0, room), Buffer.alloc(l1-room)]);
		var buf2bis = Buffer.concat([buf2.slice(-room), Buffer.alloc(l1-room)]);
		var xcBis = xcorrFFT(buf1bis, buf2bis);
		log.debug("alignAudio: check xcorr=" + xcBis.max + " at tmax=" + xcBis.tmax + " room=" + room);
	}*/

	return {
		lag: lag,
		commonAudioFirstInBuf1: commonAudioFirstInBuf1
	}
}

var getBoundsCommonAudio = function(buf1, buf2, alignData) {

	var heavisideCost = function(mxc, t1, t2) {
		var threshold = 0.50;
		var cost = 0;
		for (var i=0; i<t1; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		for (var i=t1; i<t2; i++) {
			cost += Math.pow((1-mxc[i])/(1-threshold),2);
		}
		for (var i=t2; i<mxc.length; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		return cost;
	}

	// alignData: lag, commonAudioFirstInBuf1
	var room = buf1.length - 2*alignData.lag;
	var buf1Aligned, buf2Aligned;

	if (alignData.commonAudioFirstInBuf1) {
		buf1Aligned = buf1.slice(0, room);
		buf2Aligned = buf2.slice(-room);
	} else {
		buf1Aligned = buf1.slice(-room);
		buf2Aligned = buf2.slice(0, room);
	}

	var nFFT = 2048; // number of samples in the crosscorrelation window.
	var step = nFFT/2;

	var nSteps = Math.floor((room/2-nFFT)/step);
	//log.debug("getBoundsCommonAudio: nSteps=" + nSteps);

	// compute the level of correlation for each analysis window
	var mxc = new Array(nSteps);
	for (var i=0; i<nSteps; i++) {
		var i1 = i * step * 2;
		mxc[i] = xcorrFFT(buf1Aligned.slice(i1, i1+nFFT*2), buf2Aligned.slice(i1, i1+nFFT*2)).max;
	}
	log.debug("getBoundsCommonAudio: mxc=" + JSON.stringify(mxc));

	// find b1 and b2, the bounds of the common audio segment (0 <= b1 <= b2 <= nSteps-1).
	var iMinCost = 0, minCost = Infinity;
	var b1 = 0, b2 = 0;
	for (var b2test=0; b2test<nSteps; b2test++) { // first scan in b2 with b1 = 0
		var cost = heavisideCost(mxc, b1, b2test);
		if (cost < minCost) {
			b2 = b2test;
			minCost = cost;
		}
	}
	for (var b1test=0; b1test<=b2; b1test++) { // second scan in b1 with fixed b2
		var cost = heavisideCost(mxc, b1test, b2);
		if (cost < minCost) {
			b1 = b1test;
			minCost = cost;
		}
	}
	log.debug("getBoundsCommonAudio: b1=" + b1 + " b2=" + b2 + " nSteps=" + nSteps);

	var b1Seconds = (b1*step + nFFT/2) / SAMPLING;
	var b2Seconds = (b2*step + nFFT/2) / SAMPLING;
	var lagSeconds = alignData.lag / SAMPLING;

	if (alignData.commonAudioFirstInBuf1) {
		return {
			buf1: { begin: b1Seconds, end: b2Seconds },
			buf2: { begin: lagSeconds + b1Seconds, end: lagSeconds + b2Seconds }
		}
	} else {
		return {
			buf1: { begin: lagSeconds + b1Seconds, end: lagSeconds + b2Seconds },
			buf2: { begin: b1Seconds, end: b2Seconds }
		}
	}
}

var detectXcorrSteps = function(audio1, audio2, init1, init2, freedoms, sampling) {
	// init1/2 = { "start": .. , "stop": .. } contain 2*byte indexes inside audio buffers. ie init1:2 < audio1:2.length / 2
	// freedoms is "L" if we want to optimize the start of the common audio. "R" for the end of the common audio. "LR" if we look for both.
	// will always look for values further than the corresponding start/stop value given as a parameter, so as to expand the current common audio.

	var EDGE_DT = 4;

	var heavisideCost = function(mxc, t1, t2) {
		var threshold = 0.50;
		var cost = 0;
		for (var i=0; i<t1; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		for (var i=t1; i<t2; i++) {
			cost += Math.pow((1-mxc[i])/(1-threshold),2);
		}
		for (var i=t2; i<mxc.length; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		return cost;
	}

	var lookLeft = freedoms.indexOf("L") >= 0;
	var lookRight = freedoms.indexOf("R") >= 0;

	var widthT = 8192; // xcorr window size, defines the resolution (s) = widthT / sampling
	var stepT = widthT / 4; // step size.
	var result = { "err": null, "expandDirections": "" };

	if (lookLeft) {
		var room = Math.min(init1.start, init2.start)-widthT;
		var nWin = Math.floor(room / stepT);
		if (DEBUG) log("room left=" + (room/sampling) + " s & nWin=" + nWin);
		if (nWin <= 1) {
			result.expandDirections += "L";
			//return {"error":"not enough room at left"};
		} else {
			var mxc = new Array(nWin);
			for (var i=0; i<nWin; i++) {
				var b1 = init1.start - (nWin-1-i)*stepT;
				var b2 = init2.start - (nWin-1-i)*stepT;
				mxc[i] = xcorrFFT(audio1.slice(2*(b1-widthT), 2*b1), audio2.slice(2*(b2-widthT), 2*b2), sampling).max;
				//log("mxc i=" + (nWin-1-i) + " val=" + mxc[nWin-1-i]);
			}

			var minCost = heavisideCost(mxc, nWin, nWin);
			var iminCost = nWin;
			for (var i=nWin-1; i>=0; i--) {
				var cost = heavisideCost(mxc, i, nWin);
				//log("test cost at i=" + i + " cost=" + cost);
				if (cost < minCost) {
					minCost = cost;
					iminCost = i;
				}
			}
			if (DEBUG) log("iminCost=" + iminCost + " vs nWin=" + nWin);
			init1.start = Math.round(init1.start - (nWin-1-iminCost) * stepT - widthT / 2);
			init2.start = Math.round(init2.start - (nWin-1-iminCost) * stepT - widthT / 2);

			room = Math.min(init1.start, init2.start)-widthT;
			if (room/sampling < EDGE_DT) {
				result.expandDirections += "L";
			}
			if (DEBUG) log("final room left=" + (room/sampling) + " s");

		}
		//if (result.expandDirections.indexOf("L") >= 0) {



	}

	if (lookRight) {
		var room = Math.min((audio1.length-2)/2-init1.stop, (audio2.length-2)/2-init2.stop)-widthT;
		var nWin = Math.floor(room / stepT);
		if (DEBUG) log("room right=" + (room/sampling) + " s & nWin=" + nWin);
		if (nWin <= 1) {
			result.expandDirections += "R";
			//return {"error":"not enough room at right"};
		} else {
			var mxc = new Array(nWin);
			for (var i=0; i<nWin; i++) {
				var b1 = init1.stop + i*stepT;
				var b2 = init2.stop + i*stepT;
				mxc[i] = xcorrFFT(audio1.slice(2*b1, 2*(b1+widthT)), audio2.slice(2*b2, 2*(b2+widthT)), sampling).max;
			}

			var minCost = heavisideCost(mxc, 0, 0);
			var iminCost = 0;
			for (var i=1; i<nWin; i++) {
				var cost = heavisideCost(mxc, 0, i);
				if (cost < minCost) {
					minCost = cost;
					iminCost = i;
				}
			}
			init1.stop = Math.round(init1.stop + iminCost * stepT + widthT / 2);
			init2.stop = Math.round(init2.stop + iminCost * stepT + widthT / 2);
		}

		room = Math.min((audio1.length-2)/2-init1.stop, (audio2.length-2)/2-init2.stop)-widthT;
		if (room/sampling < EDGE_DT && result.expandDirections.indexOf("R") == -1) {
			result.expandDirections += "R";
		}
		log.debug("final room right=" + (room/sampling) + " s");
	}
	return result; // result is stored in init1 & init2 objects
}


var xcorrFFT = function(buf1, buf2) {
	// ring correlation with FFT, fast & enough for what is done here.
	// assumes buf1 & buf2 are 16-bit pcm single channel buffers of same length.

	if (buf1.length != buf2.length) {
		log.error("xcorrFFT: signals have different lengths: " + buf1.length + " vs " + buf2.length + ". Abort.");
		return null;
	}

	var l = buf1.length / 2;
	var sig1 = new Array(l);
	var sig2 = new Array(l);
	var rms1=0; rms2=0;

	for (var i=0; i<l; i++) {
		sig1[i] = buf1.readInt16LE(2*i);
		sig2[i] = buf2.readInt16LE(2*i);
		rms1 += Math.pow(sig1[i],2);
		rms2 += Math.pow(sig2[i],2);
	}
	rms1 = Math.sqrt(rms1/l);
	rms2 = Math.sqrt(rms2/l);

	var fft1 = new dsp.FFT(l, SAMPLING);
	fft1.forward(sig1);
	var real1 = fft1.real, imag1 = fft1.imag;

	var fft2 = new dsp.FFT(l, SAMPLING);
	fft2.forward(sig2);
	var real2 = fft2.real, imag2 = fft2.imag;

	var realp = new Array(l), imagp = new Array(l);
	for (var i=0; i<l; i++) { // dot product of the spectra.
		realp[i] = real1[i] * real2[i] + imag1[i] * imag2[i];
		imagp[i] = - real1[i] * imag2[i] + real2[i] * imag1[i]; // we take the complex conjugate of fft2.
	}

	var fftp = new dsp.FFT(l, SAMPLING);
	var result = fftp.inverse(realp, imagp);

	// get the max of the spectrum
	var maxC = 0, tMaxC = 0, rmsTmp = 0;
	for (var i=0; i<l; i++) {
		result[i] = result[i] / rms1 / rms2 / l;
		if (Math.abs(result[i]) > maxC) {
			maxC = Math.abs(result[i]);
			tMaxC = i;
			rmsTmp += Math.pow(result[i],2);
		}
	}
	var rms = Math.sqrt(rmsTmp/l);
	//log.debug("xcorrFFT: max xcorr found at t=" + tMaxC + "/" + l + " C=" + (Math.round(maxC*1000)/1000) + " rms=" + Math.round(rms*1000)/1000);

	// Plot crosscorrelation profiles
	/*var plot = require("./plot.js");
	var imgW = l, imgH = 1024;
	var img = plot.newPng(imgW,imgH);

	var Yconvert = function(y) {
		return Math.round(imgH*(0.5+0.5*y));
	}

	for (var x=0; x<imgW; x++) {
		//log("draw marker x=" + x + " y=" + boundaries.repFun[Math.round((boundaries.nt-1)*x/(imgW-1))] + " at t=" + Math.round((boundaries.nt-1)*x/(imgW-1)));
		plot.drawMarker(img, x, Yconvert(result[Math.round(x*(l-1)/imgW)]), 2);
	}
	plot.drawLine(img, 0, imgW, Yconvert(maxC), Yconvert(maxC));
	plot.savePng(img, "xcorr.png");*/

	return {
		xcorr:result,
		tmax:tMaxC,
		max:maxC,
		rms:rms
	};
}

var path = process.argv[1].split("/");
if (process.argv.length >= 4 && path[path.length-1] == "mrs.js") {
	getMrs([process.argv[2]], [process.argv[3]], function() {
		log.debug("callback");
	});
}
