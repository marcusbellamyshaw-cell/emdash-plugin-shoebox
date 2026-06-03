export interface PhotoData {
	mediaId: string;
	url: string;
	altTextFinal: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
}

export interface CollectedData {
	story?: string;
	photos?: PhotoData[];
	location?: string;
	approxDate?: string;
	submitterName?: string;
	creditPreference?: "named" | "anonymous";
	email?: string;
	consentGiven?: boolean;
	consentTimestamp?: string;
	copyrightDeclared?: boolean;
	copyrightTimestamp?: string;
	ageConfirmed?: boolean;
	newsletterSignup?: boolean;
}

export interface InferredTaxonomy {
	categories?: string[];
	tags?: string[];
	regions?: string[];
	eras?: string[];
	people?: string[];
	content_types?: string[];
	counties?: string[];
	confidence: number;
}

export interface Session {
	id: string;
	ip: string;
	createdAt: string;
	lastActivity: string;
	turnCount: number;
	status: "active" | "completed" | "expired" | "spam";
	collected: CollectedData;
}

export interface SubmissionRecord {
	sessionId: string;
	ip: string;
	status: "pending" | "approved" | "rejected";
	createdAt: string;
	updatedAt: string;
	textHash: string;
	imageHashes: string[];
	emdashContentId?: string;
	title: string;
	submitterName: string;
	submitterEmail: string;
	location: string;
	photoCount: number;
	photos?: PhotoData[];
	taxonomyConfidence: number;
	taxonomyTags: InferredTaxonomy;
	eeatSignals: Record<string, unknown>;
	funnelAnalytics: {
		widgetOpened?: string;
		conversationStarted?: string;
		submissionCompleted?: string;
	};
}

export interface AnalyticsEvent {
	event: "widget_opened" | "conversation_started" | "submission_completed";
	date: string;
	ip: string;
	sessionId?: string;
}

export interface PluginSettings {
	enabled: boolean;
	brevoApiKey: string;
	newsletterEnabled: boolean;
	maxFileSize: number;
	maxPhotos: number;
	maxSubmissionsPerIp: number;
	maxStoryWords: number;
	sessionSecret: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	brevoApiKey: "",
	newsletterEnabled: true,
	maxFileSize: 10,
	maxPhotos: 5,
	maxSubmissionsPerIp: 3,
	maxStoryWords: 2000,
	sessionSecret: "",
};
