export type RawReviewMessage = {
   reviewId: string;
   text: string;
   timestamp: string;
};

export type AspectInsight = {
   name: string;
   sentiment: 'Positive' | 'Negative' | 'Neutral';
   mention: string;
};

export type ProcessedInsight = {
   reviewId: string;
   timestamp: string;
   summary: string;
   overall_sentiment: 'Positive' | 'Negative' | 'Neutral';
   score: number;
   aspects: AspectInsight[];
};

export type RouterIntent = 'analyzeReview' | 'generalChat';

export type RouterResult = {
   intent: RouterIntent;
};

export type ReviewAnalysisResult = {
   summary: string;
   overall_sentiment: 'Positive' | 'Negative' | 'Neutral';
   score: number;
   aspects: AspectInsight[];
};
