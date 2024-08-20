import {
    BotResponseMultiplexer,
    type ChatClient,
    type ChatMessage,
    type EditModel,
    type Message,
    PromptString,
    TokenCounterUtils,
    getSimplePreamble,
    modelsService,
    ps,
    psDedent,
} from '@sourcegraph/cody-shared'
import * as vscode from 'vscode'
import { PromptBuilder } from '../../prompt-builder'
import { fuzzyFindLocation } from '../../supercompletions/utils/fuzzy-find-location'

const SMART_APPLY_TOPICS = {
    INSTRUCTION: ps`INSTRUCTION`,
    FILE_CONTENTS: ps`FILE_CONTENTS`,
    INCOMING: ps`INCOMING`,
    REPLACE: ps`REPLACE`,
} as const

// TODO: This is Claude specific right now, we should expand and test
// this with OpenAI LLMs before opening this up to enterprise.
const LLM_PARAMETERS = {
    stopSequences: [`</${SMART_APPLY_TOPICS.REPLACE}>`],
    assistantPrefix: ps`<${SMART_APPLY_TOPICS.REPLACE}>`,
}

export const SMART_APPLY_SELECTION_PROMPT = {
    system: psDedent`
        - You are an AI programming assistant who is an expert in determining the replacement selection required to apply a suggested code change to a file.
        - The suggested code change has been generated by the AI assistant. It may have been optimized for readability and brevity. Your task is just to determine the selection of code that we need to replace, we will run a subsequent prompt to apply the change using your instructions.
        - Given the suggested change, and the file where that change should be applied, you should determine the optimum replacement selection to apply this change to the file.
        - You will be provided with the contents of the file where this change should be applied, enclosed in <${SMART_APPLY_TOPICS.FILE_CONTENTS}></${SMART_APPLY_TOPICS.FILE_CONTENTS}> XML tags.
        - You will be provided with the incoming change to this file, enclosed in <${SMART_APPLY_TOPICS.INCOMING}></${SMART_APPLY_TOPICS.INCOMING}> XML tags.
        - You will be provided with an instruction that the user provided to generate the incoming change, enclosed in <${SMART_APPLY_TOPICS.INSTRUCTION}></${SMART_APPLY_TOPICS.INSTRUCTION}> XML tags.
        - Do not provide any additional commentary about the changes you made.`,
    instruction: psDedent`
        We are in the file: {filePath}

        This file contains the following code:
        <${SMART_APPLY_TOPICS.FILE_CONTENTS}>{fileContents}</${SMART_APPLY_TOPICS.FILE_CONTENTS}>

        We have the following code to apply to the file:
        <${SMART_APPLY_TOPICS.INCOMING}>{incomingText}</${SMART_APPLY_TOPICS.INCOMING}>

        We generated this code from the following instruction that the user provided:
        <${SMART_APPLY_TOPICS.INSTRUCTION}>{instruction}</${SMART_APPLY_TOPICS.INSTRUCTION}>

        Your aim is to respond with the original code that should be updated, enclosed in <${SMART_APPLY_TOPICS.REPLACE}></${SMART_APPLY_TOPICS.REPLACE}> XML tags.

        Follow these specific rules:
        - You should think step-by-step, first looking inside the <${SMART_APPLY_TOPICS.FILE_CONTENTS}></${SMART_APPLY_TOPICS.FILE_CONTENTS}> XML tags to see if there is any code that should be replaced.
        - If you find code that should be replaced, respond with the original code enclosed within <${SMART_APPLY_TOPICS.REPLACE}></${SMART_APPLY_TOPICS.REPLACE}> XML tags.
        - If you cannot find any code that should be replaced, and believe this code should be inserted into the file, respond with "<${SMART_APPLY_TOPICS.REPLACE}>INSERT</${SMART_APPLY_TOPICS.REPLACE}>"
        - If you believe that the entire contents of the file should be replaced, respond with "<${SMART_APPLY_TOPICS.REPLACE}>ENTIRE_FILE</${SMART_APPLY_TOPICS.REPLACE}>"
        - If you are unsure, respond with "<${SMART_APPLY_TOPICS.REPLACE}>ENTIRE_FILE</${SMART_APPLY_TOPICS.REPLACE}>". We will execute another prompt to apply the change correctly to this file.
    `,
}

export const getPrompt = async (
    instruction: PromptString,
    replacement: PromptString,
    document: vscode.TextDocument,
    model: EditModel,
    codyApiVersion: number
): Promise<{ messages: Message[]; prefix: string }> => {
    const documentRange = new vscode.Range(0, 0, document.lineCount - 1, 0)
    const documentText = PromptString.fromDocumentText(document, documentRange)
    const tokenCount = await TokenCounterUtils.countPromptString(documentText)
    const contextWindow = modelsService.getContextWindowByID(model)
    if (tokenCount > contextWindow.input) {
        throw new Error("The amount of text in this document exceeds Cody's current capacity.")
    }

    const promptBuilder = await PromptBuilder.create(contextWindow)
    const preamble = getSimplePreamble(model, codyApiVersion, SMART_APPLY_SELECTION_PROMPT.system)
    promptBuilder.tryAddToPrefix(preamble)

    const text = SMART_APPLY_SELECTION_PROMPT.instruction
        .replaceAll('{instruction}', instruction)
        .replaceAll('{incomingText}', replacement)
        .replaceAll('{fileContents}', documentText)
        .replaceAll('{filePath}', PromptString.fromDisplayPath(document.uri))

    const transcript: ChatMessage[] = [{ speaker: 'human', text }]
    transcript.push({ speaker: 'assistant', text: LLM_PARAMETERS.assistantPrefix })

    promptBuilder.tryAddMessages(transcript.reverse())

    return { prefix: LLM_PARAMETERS.assistantPrefix.toString(), messages: promptBuilder.build() }
}

export async function promptModelForOriginalCode(
    instruction: PromptString,
    replacement: PromptString,
    document: vscode.TextDocument,
    model: EditModel,
    client: ChatClient,
    codyApiVersion: number
): Promise<string> {
    const multiplexer = new BotResponseMultiplexer()
    const contextWindow = modelsService.getContextWindowByID(model)

    let text = ''
    multiplexer.sub(SMART_APPLY_TOPICS.REPLACE.toString(), {
        onResponse: async (content: string) => {
            text += content
        },
        onTurnComplete: async () => {
            Promise.resolve(text)
        },
    })

    const abortController = new AbortController()
    const { prefix, messages } = await getPrompt(
        instruction,
        replacement,
        document,
        model,
        codyApiVersion
    )
    const stream = client.chat(
        messages,
        {
            model,
            stopSequences: LLM_PARAMETERS.stopSequences,
            maxTokensToSample: contextWindow.output,
        },
        abortController.signal
    )

    let textConsumed = 0
    for await (const message of stream) {
        switch (message.type) {
            case 'change': {
                if (textConsumed === 0 && prefix) {
                    void multiplexer.publish(prefix)
                }
                const text = message.text.slice(textConsumed)
                textConsumed += text.length
                void multiplexer.publish(text)
                break
            }
            case 'complete': {
                await multiplexer.notifyTurnComplete()
                break
            }
            case 'error': {
                throw message.error
            }
        }
    }

    return text
}

export function getFullRangeofDocument(document: vscode.TextDocument): vscode.Range {
    const endOfDocument = document.lineCount - 1
    const lastLine = document.lineAt(endOfDocument)
    const range = new vscode.Range(0, 0, endOfDocument, lastLine.range.end.character)
    return range
}

interface SmartSelection {
    type: 'insert' | 'selection' | 'entire-file'
    range: vscode.Range
}

export async function getSmartApplySelection(
    instruction: PromptString,
    replacement: PromptString,
    document: vscode.TextDocument,
    model: EditModel,
    client: ChatClient,
    codyApiVersion: number
): Promise<SmartSelection | null> {
    let originalCode: string
    try {
        originalCode = await promptModelForOriginalCode(
            instruction,
            replacement,
            document,
            model,
            client,
            codyApiVersion
        )
    } catch (error: unknown) {
        // We erred when asking the LLM to produce the original code.
        // Surface this error back to the user
        vscode.window.showErrorMessage(
            `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`
        )
        return null
    }

    if (originalCode.trim().length === 0 || originalCode.trim() === 'INSERT') {
        // Insert flow. Cody thinks that this code should be inserted into the document.
        // Add the code to the end position of the document.
        const range = getFullRangeofDocument(document)
        return {
            type: 'insert',
            range: new vscode.Range(range.end, range.end),
        }
    }

    if (originalCode.trim() === 'ENTIRE_FILE') {
        // Replace flow. Cody thinks that the entire file should be replaced.
        // Replace the entire file.
        // Note: This is essentially a shortcut for a common use case,
        // we don't want Cody to repeat the entire file if we can avoid it.
        const range = new vscode.Range(0, 0, document.lineCount - 1, 0)
        return {
            type: 'entire-file',
            range,
        }
    }

    const fuzzyLocation = fuzzyFindLocation(document, originalCode)
    if (!fuzzyLocation) {
        // Cody told us we need to replace some code, but we couldn't find where to replace it
        return null
    }

    if (
        fuzzyLocation.location.range.isEmpty ||
        document.getText(fuzzyLocation.location.range).trim() === ''
    ) {
        // Cody returned a selection, but it was empty. We ensure that we treat this as an 'insert'
        // rather than a 'selection' and replace.
        return {
            type: 'insert',
            range: new vscode.Range(fuzzyLocation.location.range.end, fuzzyLocation.location.range.end),
        }
    }

    // We found a matching selection in the text, let's use this!
    return {
        type: 'selection',
        range: fuzzyLocation.location.range,
    }
}

export const SMART_APPLY_FILE_DECORATION = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.unchangedCodeBackground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
})