'use strict';

const axios = require('axios');
const tar = require('tar');
const fs = require('fs-extra');
const { log } = require('abr-log')('checkModelUpdates');

const MODELS_REPOSITORY = 'https://www.adblockradio.com/models/';
const METADATA_REPOSITORY = 'https://www.adblockradio.com/metadata/';
const CHECKSUM_SUFFIX = '.sha256sum';

const isToUpdate = async function(localPath, remotePath, file) {
	let localChecksum = null;
	try {
		localChecksum = await fs.readFile(localPath + '/' + file + CHECKSUM_SUFFIX);
	} catch (e) {
		log.info('checksum for ' + localPath + '/' + file + ' not found. Will fetch models.');
		return true;
	}
	const remoteFile = remotePath + file + CHECKSUM_SUFFIX;
	try {
		const remoteChecksum = await axios.get(encodeURI(remoteFile));
		if ('' + localChecksum !== '' + remoteChecksum.data) {
			//log.info('different checksums local=' + localChecksum + ' remote=' + remoteChecksum.data);
			return true;
		} else {
			log.info(file + ' is up to date');
			return false;
		}
	} catch (e) {
		log.warn('could not fetch ' + remoteFile + '. err=' + e);
		return false;
	}
}

const update = async function(localPath, remotePath, file) {
	log.info('update ' + localPath + '/' + file);
	try {
		const checksumData = await axios.get(encodeURI(remotePath + file + CHECKSUM_SUFFIX));
		await fs.writeFile(localPath + '/' + file + CHECKSUM_SUFFIX, checksumData.data);
		const data = await axios.get(encodeURI(remotePath + file), { responseType: 'arraybuffer' });
		await fs.writeFile(localPath + '/' + file, data.data);
		await tar.x({ file: localPath + '/' + file, cwd: localPath, strict: true });
		await fs.unlink(localPath + '/' + file);
	} catch (e) {
		log.warn('could not update with remote ' + remotePath + file + '. err=' + e);
	}
}

exports.checkModelUpdates = async function(country, name, modelsPath, mlUpdateCallback, hotlistUpdateCallback) {
	const canonical = country + '_' + name;
	const modelFile = canonical + '.keras.tar.gz';
	if (await isToUpdate(modelsPath, MODELS_REPOSITORY, modelFile)) {
		await update(modelsPath, MODELS_REPOSITORY, modelFile);
		if (mlUpdateCallback) mlUpdateCallback();
	}
	const hotlistFile = canonical + '.sqlite.tar.gz';
	if (await isToUpdate(modelsPath, MODELS_REPOSITORY, hotlistFile)) {
		await update(modelsPath, MODELS_REPOSITORY, hotlistFile);
		if (hotlistUpdateCallback) hotlistUpdateCallback();
	}
}

exports.checkMetadataUpdates = async function(updateCallback) {
	log.debug("check meta updates");
	if (await isToUpdate(process.cwd(), METADATA_REPOSITORY, 'webradio-metadata.js.tar.gz')) {
		await update(process.cwd(), METADATA_REPOSITORY, 'webradio-metadata.js.tar.gz')
		if (updateCallback) updateCallback();
	}
}