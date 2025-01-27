import type { CodyIDE, SerializedChatTranscript, UserLocalHistory } from '@sourcegraph/cody-shared'
import { useExtensionAPI, useObservable } from '@sourcegraph/prompt-editor'
import {
    HistoryIcon,
    MessageSquarePlusIcon,
    MessageSquareTextIcon,
    PenIcon,
    TrashIcon,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { WebviewType } from '../../src/chat/protocol'
import { getRelativeChatPeriod } from '../../src/common/time-date'
import { LoadingDots } from '../chat/components/LoadingDots'
import { CollapsiblePanel } from '../components/CollapsiblePanel'
import { Button } from '../components/shadcn/ui/button'
import { getVSCodeAPI } from '../utils/VSCodeApi'
import { View } from './types'
import { getCreateNewChatCommand } from './utils'

interface HistoryTabProps {
    IDE: CodyIDE
    setView: (view: View) => void
    webviewType?: WebviewType | undefined | null
    multipleWebviewsEnabled?: boolean | undefined | null
}

export const HistoryTab: React.FC<HistoryTabProps> = props => {
    const userHistory = useUserHistory()
    const chats = useMemo(
        () => (userHistory ? Object.values(userHistory.chat) : userHistory),
        [userHistory]
    )

    return (
        <div className="tw-px-8 tw-pt-6 tw-pb-12">
            {chats === undefined ? (
                <LoadingDots />
            ) : chats === null ? (
                <p>History is not available.</p>
            ) : (
                <HistoryTabWithData {...props} chats={chats} />
            )}
        </div>
    )
}

export const HistoryTabWithData: React.FC<
    HistoryTabProps & { chats: UserLocalHistory['chat'][string][] }
> = ({ IDE, webviewType, multipleWebviewsEnabled, setView, chats }) => {
    const nonEmptyChats = useMemo(() => chats.filter(chat => chat.interactions.length > 0), [chats])
    const [editingId, setEditingId] = useState<string | null>(null)
    const [newTitle, setNewTitle] = useState('')

    const chatByPeriod = useMemo(
        () =>
            Array.from(
                nonEmptyChats
                    .filter(chat => chat.interactions.length)
                    .reverse()
                    .reduce((acc, chat) => {
                        const period = getRelativeChatPeriod(new Date(chat.lastInteractionTimestamp))
                        acc.set(period, [...(acc.get(period) || []), chat])
                        return acc
                    }, new Map<string, SerializedChatTranscript[]>())
            ),
        [nonEmptyChats]
    )

    const onDeleteButtonClick = useCallback(
        (id: string) => {
            if (chats.find(chat => chat.id === id)) {
                getVSCodeAPI().postMessage({
                    command: 'command',
                    id: 'cody.chat.history.clear',
                    arg: id,
                })
            }
        },
        [chats]
    )

    const handleStartNewChat = () => {
        getVSCodeAPI().postMessage({
            command: 'command',
            id: getCreateNewChatCommand({ IDE, webviewType, multipleWebviewsEnabled }),
        })
        setView(View.Chat)
    }
    const onEditButtonClick = useCallback(
        (id: string) => {
            setEditingId(id)
            const chat = chats.find(chat => chat.id === id)
            setNewTitle(chat?.chatTitle || '')
        },
        [chats]
    )

    const onSaveTitle = useCallback(
        (id: string, newTitle: string) => {
            // First update in local state
            const chat = chats.find(chat => chat.id === id)
            if (chat) {
                chat.chatTitle = newTitle
                // Send message to update in extension
                getVSCodeAPI().postMessage({
                    command: 'updateChatTitle',
                    chatID: id,
                    newTitle: newTitle,
                })
                setEditingId(null)
            }
        },
        [chats]
    )

    return (
        <div className="tw-flex tw-flex-col tw-gap-10">
            {chatByPeriod.map(([period, chats]) => (
                <CollapsiblePanel
                    id={`history-${period}`.replaceAll(' ', '-').toLowerCase()}
                    key={period}
                    storageKey={`history.${period}`}
                    title={period}
                    initialOpen={true}
                >
                    {chats.map(({ interactions, id, chatTitle }) => {
                        const firstMessageOrTitle = chatTitle
                            ? chatTitle
                            : interactions[0]?.humanMessage?.text?.trim()

                        return (
                            <div key={id} className="tw-inline-flex tw-justify-between">
                                {editingId === id ? (
                                    <div className="tw-flex tw-w-full tw-gap-2">
                                        <input
                                            type="text"
                                            value={newTitle}
                                            onChange={e => setNewTitle(e.target.value)}
                                            className="tw-w-full tw-px-2 tw-py-1 tw-rounded tw-bg-transparent tw-border"
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    getVSCodeAPI().postMessage({
                                                        command: 'updateChatTitle',
                                                        chatID: id,
                                                        newTitle,
                                                    })
                                                    setEditingId(null)
                                                } else if (e.key === 'Escape') {
                                                    setEditingId(null)
                                                }
                                            }}
                                        />
                                        <Button
                                            variant="ghost"
                                            onClick={() => onSaveTitle(id, newTitle)}
                                        >
                                            Save
                                        </Button>
                                        <Button variant="ghost" onClick={() => setEditingId(null)}>
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <>
                                        <Button
                                            variant="ghost"
                                            title={firstMessageOrTitle}
                                            onClick={() =>
                                                getVSCodeAPI().postMessage({
                                                    command: 'restoreHistory',
                                                    chatID: id,
                                                })
                                            }
                                            className="tw-text-left tw-truncate tw-w-full"
                                        >
                                            <MessageSquareTextIcon
                                                className="tw-w-8 tw-h-8 tw-opacity-80"
                                                size={16}
                                                strokeWidth="1.25"
                                            />
                                            <span className="tw-truncate tw-w-full">
                                                {firstMessageOrTitle}
                                            </span>
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            title="Edit chat title"
                                            onClick={() => onEditButtonClick(id)}
                                        >
                                            <PenIcon
                                                className="tw-w-8 tw-h-8 tw-opacity-80"
                                                size={16}
                                                strokeWidth="1.25"
                                            />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            title="Delete chat"
                                            onClick={() => onDeleteButtonClick(id)}
                                        >
                                            <TrashIcon
                                                className="tw-w-8 tw-h-8 tw-opacity-80"
                                                size={16}
                                                strokeWidth="1.25"
                                            />
                                        </Button>
                                    </>
                                )}
                            </div>
                        )
                    })}
                </CollapsiblePanel>
            ))}

            {nonEmptyChats.length === 0 && (
                <div className="tw-flex tw-flex-col tw-items-center tw-mt-6">
                    <HistoryIcon
                        size={20}
                        strokeWidth={1.25}
                        className="tw-mb-5 tw-text-muted-foreground"
                    />

                    <span className="tw-text-lg tw-mb-4 tw-text-muted-foreground">
                        You have no chat history
                    </span>

                    <span className="tw-text-sm tw-text-muted-foreground tw-mb-8">
                        Explore all your previous chats here. Track and <br /> search through what you’ve
                        been working on.
                    </span>

                    <Button
                        size="sm"
                        variant="secondary"
                        aria-label="Start a new chat"
                        className="tw-px-4 tw-py-2"
                        onClick={handleStartNewChat}
                    >
                        <MessageSquarePlusIcon size={16} className="tw-w-8 tw-h-8" strokeWidth={1.25} />
                        Start a new chat
                    </Button>
                </div>
            )}
        </div>
    )
}

function useUserHistory(): UserLocalHistory | null | undefined {
    const userHistory = useExtensionAPI().userHistory
    return useObservable(useMemo(() => userHistory(), [userHistory])).value
}
