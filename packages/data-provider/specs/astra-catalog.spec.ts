import { EModelEndpoint } from '../src/schemas';
import { defaultModels, initialModelsConfig } from '../src/config';

/**
 * GPT-6 reasoning with tools requires the Responses API. The Assistants
 * endpoints do not route through `getOpenAILLMConfig`, so listing it there
 * would offer a configuration the provider rejects.
 */
describe.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('%s catalog placement', (model) => {
  it('is offered on the endpoints that route through the OpenAI config', () => {
    expect(defaultModels[EModelEndpoint.openAI]).toContain(model);
    expect(defaultModels[EModelEndpoint.agents]).toContain(model);
  });

  it('is kept out of both Assistants catalogs', () => {
    expect(defaultModels[EModelEndpoint.assistants]).not.toContain(model);
    expect(defaultModels[EModelEndpoint.azureAssistants]).not.toContain(model);
  });

  it('is kept out of the initial Azure and Assistants catalogs', () => {
    /**
     * Configured Azure deployments supply their own model list. Adding OpenAI
     * models must not change Azure's fallback default selection.
     */
    expect(initialModelsConfig[EModelEndpoint.azureOpenAI]).not.toContain(model);
    expect(initialModelsConfig[EModelEndpoint.assistants]).not.toContain(model);
  });

  it('keeps the model in the initial catalogs that can run it', () => {
    expect(initialModelsConfig[EModelEndpoint.openAI]).toContain(model);
    expect(initialModelsConfig[EModelEndpoint.agents]).toContain(model);
  });

  it('does not disturb the rest of the shared OpenAI catalog', () => {
    for (const endpoint of [
      EModelEndpoint.openAI,
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
    ]) {
      expect(defaultModels[endpoint]).toContain('gpt-5.6');
    }
  });
});
