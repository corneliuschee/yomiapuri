export function createJsonStateStore({ getState, setState, saveState }) {
  const update = async (mutator) => {
    const result = mutator(getState());
    await saveState();
    return result;
  };

  return {
    getState,
    update,
    documents: {
      findById(id) {
        return getState().documents.find((item) => item.id === id);
      }
    },
    anki: {
      getSettings() {
        return getState().anki;
      },
      async updateSettings(patch) {
        return update((state) => {
          state.anki = {
            ...state.anki,
            ...patch,
            fieldMap: { ...state.anki.fieldMap, ...(patch.fieldMap ?? {}) },
            modelFieldMaps: { ...(state.anki.modelFieldMaps ?? {}), ...(patch.modelFieldMaps ?? {}) }
          };
          return state.anki;
        });
      },
      async saveRetentionStats(retentionStats) {
        return update((state) => {
          state.anki.retentionStats = retentionStats;
          return state.anki.retentionStats;
        });
      },
      async saveModelFieldMap(modelName, fieldMap) {
        return update((state) => {
          state.anki.modelFieldMaps ??= {};
          state.anki.modelFieldMaps[modelName] = { ...(state.anki.modelFieldMaps[modelName] ?? {}), ...fieldMap };
          return state.anki.modelFieldMaps[modelName];
        });
      }
    },
    media: {
      getSettings() {
        return getState().media;
      },
      async updateSettings(patch, normalizeMediaSettings) {
        return update((state) => {
          state.media = normalizeMediaSettings({
            ...(state.media ?? {}),
            ...patch,
            audio: { ...(state.media?.audio ?? {}), ...(patch.audio ?? {}) },
            image: { ...(state.media?.image ?? {}), ...(patch.image ?? {}) }
          });
          return state.media;
        });
      }
    },
    cards: {
      async add(card) {
        return update((state) => {
          state.cards.unshift(card);
          return card;
        });
      }
    },
    knownTerms: {
      async merge(terms, mergeKnownTerms, metadataByTerm = {}) {
        return update(() => mergeKnownTerms(terms, undefined, metadataByTerm));
      }
    }
  };
}
