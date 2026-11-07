import { createContext, createElement, useContext } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ClientStore } from "./client-store.js";

const ClientStoreContext = createContext<StoreApi<ClientStore> | null>(null);

/** Supplies the store instance created by the browser entry (or a test). */
export function ClientStoreProvider(props: {
  readonly store: StoreApi<ClientStore>;
  readonly children?: ReactNode;
}): ReactNode {
  return createElement(ClientStoreContext.Provider, { value: props.store }, props.children);
}

/** Select a slice of the client store. Must be used under `ClientStoreProvider`. */
export function useClientStore<T>(selector: (state: ClientStore) => T): T {
  const store = useContext(ClientStoreContext);
  if (store === null) {
    throw new Error("useClientStore must be used inside <ClientStoreProvider>");
  }
  return useStore(store, selector);
}
