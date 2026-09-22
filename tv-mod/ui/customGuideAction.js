import { configChangeEmitter, configRead } from "../config.js";
import getCommandExecutor from "./customCommandExecution.js";

// Store a reference to the guide section so we can inject topics later if they load after the initial parse
window.__GUIDE_SECTION_ITEMS__ = null;

const origParse = JSON.parse;
JSON.parse = function () {
    const r = origParse.apply(this, arguments);

    const disabledSidebarContents = configRead('disabledSidebarContents');
    const disableChannelsOnSidebar = configRead('disableChannelsOnSidebar');
    if (r.items && Array.isArray(r.items) && r.items[0].guideSectionRenderer) {
        for (let i = 0; i < r.items.length; i++) {
            const section = r.items[i].guideSectionRenderer;
            for (let j = 0; j < section.items.length; j++) {
                const item = section.items[j].guideEntryRenderer;
                if (!item) continue;
                if ((disabledSidebarContents?.length && disabledSidebarContents.includes(item.icon?.iconType))
                    || (disableChannelsOnSidebar && item?.thumbnail)) {
                    section.items.splice(j, 1);
                    j--;
                }
            }
        }

        // Add Pulse Feeds item to the top of the main section
        const firstSection = r.items[0].guideSectionRenderer;
        if (firstSection && firstSection.items) {
            window.__GUIDE_SECTION_ITEMS__ = firstSection.items; // Store reference for delayed injection
            
            // Add Pulse All tab at index 1 of the first section (after Home)
            if (!firstSection.items.some(item => item.guideEntryRenderer?.navigationEndpoint?.browseEndpoint?.browseId === 'FE_pulse_feeds')) {
                firstSection.items.splice(1, 0, {
                    guideEntryRenderer: {
                        targetId: "browse-feedFE_pulse_feeds",
                        trackingParams: "pulse_track_FE_pulse_feeds",
                        formattedTitle: { simpleText: "Pulse All" },
                        icon: { iconType: "TRENDING_UP" },
                        navigationEndpoint: {
                            browseEndpoint: {
                                browseId: "FE_pulse_feeds"
                            }
                        },
                        presentationStyle: "GUIDE_ENTRY_PRESENTATION_STYLE_DEFAULT"
                    }
                });
            }

            // Dynamically add ALL tabs for each Topic
            if (window.__PULSE_TOPICS__ && Array.isArray(window.__PULSE_TOPICS__)) {
                const activeTopics = window.__PULSE_TOPICS__.filter(t => t.enabled !== false);
                activeTopics.slice().reverse().forEach(topic => {
                    const browseId = `FE_pulse_feeds_${topic.id}`;
                    if (!firstSection.items.some(item => item.guideEntryRenderer?.navigationEndpoint?.browseEndpoint?.browseId === browseId)) {
                        firstSection.items.splice(2, 0, {
                            guideEntryRenderer: {
                                targetId: `browse-feed${browseId}`,
                                trackingParams: `pulse_track_${browseId}`,
                                formattedTitle: { simpleText: topic.name },
                                icon: { iconType: "PLAYLISTS" },
                                navigationEndpoint: {
                                    browseEndpoint: {
                                        browseId: browseId
                                    }
                                },
                                presentationStyle: "GUIDE_ENTRY_PRESENTATION_STYLE_DEFAULT"
                            }
                        });
                    }
                });
            }
        }

    }

    return r;
}

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'disabledSidebarContents' || e.detail.key === 'disableChannelsOnSidebar') {
        const commandExecutor = getCommandExecutor();
        if (commandExecutor) {
            commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
        }
    }
});

// When topics finally load from Surge, just force a guide reload!
window.addEventListener('pulse_topics_loaded', () => {
    if (window.__GUIDE_SECTION_ITEMS__ && window.__PULSE_TOPICS__) {
        const firstSectionItems = window.__GUIDE_SECTION_ITEMS__;
        const activeTopics = window.__PULSE_TOPICS__.filter(t => t.enabled !== false);
        activeTopics.slice().reverse().forEach(topic => {
            const browseId = `FE_pulse_feeds_${topic.id}`;
            if (!firstSectionItems.some(item => item.guideEntryRenderer?.navigationEndpoint?.browseEndpoint?.browseId === browseId)) {
                firstSectionItems.splice(2, 0, {
                    guideEntryRenderer: {
                        targetId: `browse-feed${browseId}`,
                        trackingParams: `pulse_track_${browseId}`,
                        formattedTitle: { simpleText: topic.name },
                        icon: { iconType: "PLAYLISTS" },
                        navigationEndpoint: {
                            browseEndpoint: {
                                browseId: browseId
                            }
                        },
                        presentationStyle: "GUIDE_ENTRY_PRESENTATION_STYLE_DEFAULT"
                    }
                });
            }
        });
    }

    let retries = 0;
    function tryReload() {
        const commandExecutor = getCommandExecutor();
        if (commandExecutor) {
            commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
            console.log('[PulseTube TV] Reloaded guide to show dynamically loaded topics.');
        } else if (retries < 20) {
            retries++;
            setTimeout(tryReload, 500);
        }
    }
    tryReload();
});