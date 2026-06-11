import { Injectable, Logger } from "@nestjs/common";
import {
  AiUnavailableError,
  type AiService,
  type AiSuggestionRequest,
  type AiSuggestions,
} from "@slugbase/shared-types";

/**
 * No-op AI implementation - used when OPENAI_API_KEY is not configured.
 * Logs a warning on suggest attempts so operators know AI is degraded.
 */
@Injectable()
export class NoopAiService implements AiService {
  private readonly logger = new Logger(NoopAiService.name);

  suggest(request: AiSuggestionRequest): Promise<AiSuggestions> {
    this.logger.warn("AI provider not configured - suggestion skipped", {
      url: request.url,
      outputLanguage: request.outputLanguage,
    });
    return Promise.reject(new AiUnavailableError());
  }

  isAvailable(): boolean {
    return false;
  }
}
