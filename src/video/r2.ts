export interface R2PartHandle {
	uploadPart(
		partNumber: number,
		value: ArrayBuffer | ArrayBufferView | Uint8Array,
	): Promise<{ partNumber: number; etag: string }>;
	complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
	abort(): Promise<void>;
}

export interface R2MultipartBinding {
	createMultipartUpload(key: string): Promise<{ uploadId: string }>;
	resumeMultipartUpload(key: string, uploadId: string): R2PartHandle;
	get(
		key: string,
		opts?: { range?: { offset: number; length: number } },
	): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	delete(key: string): Promise<void>;
}

const VIDEO_PREFIX = "shoebox-video/";

export function videoKey(submissionId: string, ext: string): string {
	return `${VIDEO_PREFIX}${submissionId}${ext}`;
}

/** Read a byte range from R2 as a Uint8Array (for the resumable YouTube push). */
export async function readRange(
	bucket: R2MultipartBinding,
	key: string,
	offset: number,
	length: number,
): Promise<Uint8Array> {
	const obj = await bucket.get(key, { range: { offset, length } });
	if (!obj) throw new Error(`R2 object not found: ${key}`);
	return new Uint8Array(await obj.arrayBuffer());
}
