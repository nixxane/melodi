import { createContext, useContext } from "react";
import type { Item } from "../types";

/** App-wide navigation and playback actions used by rows, cards and pages. */
export interface Actions {
  /** Open an album / playlist / artist page for a non-song item. */
  open: (item: Item) => void;
  openArtist: (id: string, name: string) => void;
  openAlbum: (id: string, title: string) => void;
  startRadio: (item: Item) => void;
  playNext: (item: Item) => void;
  addToQueue: (item: Item) => void;
  /** Open the "add to playlist" picker for these songs. */
  addToPlaylist: (items: Item[]) => void;
}

const noop = () => {};
export const ActionsContext = createContext<Actions>({
  open: noop,
  openArtist: noop,
  openAlbum: noop,
  startRadio: noop,
  playNext: noop,
  addToQueue: noop,
  addToPlaylist: noop,
});

export const useActions = () => useContext(ActionsContext);
