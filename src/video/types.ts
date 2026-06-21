import type { VideoState } from "./state.js";

export interface VideoUpload {
	r2Key: string;
	uploadId?: string;
	sizeBytes: number;
	contentType: string;
	originalFilename: string;
	parts: { partNumber: number; etag: string }[];
}

export interface YoutubeTransfer {
	state: VideoState;
	videoId?: string;
	resumableUri?: string;
	bytesSent: number;
	error?: string;
	attempts: number;
}
