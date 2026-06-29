export function createJsonStateStore({ getState, setState, saveState }) {
  const update = async (mutator, options = {}) => {
    const result = mutator(getState());
    if (options.save !== false) await saveState();
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
      async updateSettings(patch, options = {}) {
        return update((state) => {
          state.anki = {
            ...state.anki,
            ...patch,
            fieldMap: { ...state.anki.fieldMap, ...(patch.fieldMap ?? {}) },
            modelFieldMaps: { ...(state.anki.modelFieldMaps ?? {}), ...(patch.modelFieldMaps ?? {}) }
          };
          return state.anki;
        }, options);
      },
      async saveRetentionStats(retentionStats) {
        return update((state) => {
          state.anki.retentionStats = retentionStats;
          return state.anki.retentionStats;
        });
      },
      async saveModelFieldMap(modelName, fieldMap, options = {}) {
        return update((state) => {
          state.anki.modelFieldMaps ??= {};
          state.anki.modelFieldMaps[modelName] = { ...(state.anki.modelFieldMaps[modelName] ?? {}), ...fieldMap };
          return state.anki.modelFieldMaps[modelName];
        }, options);
      }
    },
    media: {
      getSettings() {
        return getState().media;
      },
      async updateSettings(patch, normalizeMediaSettings, options = {}) {
        return update((state) => {
          state.media = normalizeMediaSettings({
            ...(state.media ?? {}),
            ...patch,
            audio: { ...(state.media?.audio ?? {}), ...(patch.audio ?? {}) },
            image: { ...(state.media?.image ?? {}), ...(patch.image ?? {}) }
          });
          return state.media;
        }, options);
      }
    },
    cards: {
      async add(card, options = {}) {
        return update((state) => {
          state.cards.unshift(card);
          return card;
        }, options);
      }
    },
    knownTerms: {
      async merge(terms, mergeKnownTerms, metadataByTerm = {}, options = {}) {
        return update(() => mergeKnownTerms(terms, undefined, metadataByTerm), options);
      }
    }
  };
}
