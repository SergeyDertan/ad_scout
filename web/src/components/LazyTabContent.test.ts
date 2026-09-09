import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChakraProvider, Tabs } from '@chakra-ui/react';
import { system } from '../theme';
import { LazyTabContent } from './LazyTabContent';

test('inactive visited tab content is explicitly removed from layout', () => {
  const tabs = createElement(
        Tabs.Root,
        { value: 'run' },
        createElement(LazyTabContent, { value: 'domains', active: false, children: 'Domains page' }),
        createElement(LazyTabContent, { value: 'run', active: true, children: 'Run page' }),
  );
  const html = renderToStaticMarkup(
    createElement(ChakraProvider, { value: system, children: tabs }),
  );

  const domains = html.match(/<div[^>]*>Domains page<\/div>/)?.[0] ?? '';
  const run = html.match(/<div[^>]*>Run page<\/div>/)?.[0] ?? '';
  assert.match(domains, /hidden=""/);
  assert.match(domains, /style="display:none"/);
  assert.doesNotMatch(run, /hidden=""/);
  assert.match(run, /style="display:block"/);
});
