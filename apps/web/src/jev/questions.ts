export type TopicQuestion = { id: string; instructions: string };

export function buildSystemOneBody(input: {
  model: string;
  brandName: string;
  text: string;
  topics: TopicQuestion[];
}): { model: string; state: { brand: string; text: string }; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {
    relevant: {
      type: "noul",
      instructions: "The post is about the named brand.",
      criteria: {
        true: "A reader would treat the post as a mention of this brand.",
        false: "The words are unrelated, including a different product that only shares part of the name.",
      },
    },
    sentiment: {
      type: "choice",
      instructions: "What is the sentiment toward the brand?",
      criteria: {
        positive: "Praise or a favorable experience",
        neutral: "A factual or mixed mention without a clear favorable or unfavorable stance",
        negative: "A complaint or an unfavorable experience",
      },
    },
  };
  for (const topic of input.topics) {
    questions[`topic_${topic.id}`] = {
      type: "noul",
      instructions: topic.instructions,
    };
  }
  return { model: input.model, state: { brand: input.brandName, text: input.text }, questions };
}
